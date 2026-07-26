#!/bin/sh
# ─────────────────────────────────────────────────────────────
# RunnerLens — Background Metric Collector (v2)
#
# POSIX sh — works on Alpine, Ubuntu, and all Linux runners.
# Reads directly from /proc for minimal overhead.
# Writes one JSON line per sample to the output file.
#
# Usage: collect.sh <output> <interval> [--max-size=N]
#
# The reader helpers below deliberately return space-separated fields that are
# split into positional parameters via `set -- $(...)`. That word splitting is
# the mechanism, not an accident, so SC2046/SC2086 are disabled file-wide.
# ─────────────────────────────────────────────────────────────
# shellcheck disable=SC2046,SC2086
set -eu

OUT="${1:?Usage: collect.sh <output> <interval> [--max-size=N]}"
INTERVAL="${2:-5}"
shift 2 2>/dev/null || true

MAX_SIZE_MB=100
for a in "$@"; do
  case "$a" in
    --max-size=*) MAX_SIZE_MB="${a#--max-size=}" ;;
  esac
done

# ── validate ───────────────────────────────────────────────
case "$INTERVAL" in
  *[!0-9]*|'') echo "ERROR: interval must be 1-60" >&2; exit 1 ;;
esac
[ "$INTERVAL" -ge 1 ] && [ "$INTERVAL" -le 60 ] || {
  echo "ERROR: interval must be 1-60" >&2; exit 1
}
case "$MAX_SIZE_MB" in
  *[!0-9]*|'') echo "ERROR: max-size must be a non-negative integer" >&2; exit 1 ;;
esac

# ── ensure output directory exists ─────────────────────────
mkdir -p "$(dirname "$OUT")"

# ── clean shutdown (set early so seed phase is covered) ────
trap 'exit 0' TERM INT

# ── detect metric source ─────────────────────────────────
CG_CPU="/sys/fs/cgroup/cpu.stat"
CG_MEM="/sys/fs/cgroup/memory.current"

if [ -r "$CG_CPU" ] && [ -r "$CG_MEM" ]; then
  METRIC_SRC="cgroup"
else
  METRIC_SRC="proc"
fi

# Number of CPUs — needed for cgroup CPU normalization
NUM_CPUS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)
case "$NUM_CPUS" in
  ''|*[!0-9]*|0) NUM_CPUS=1 ;;
esac

# ── previous-sample state for delta calculations ───────────
# /proc path
p_user=0 p_nice=0 p_sys=0 p_idle=0 p_iow=0 p_irq=0 p_sirq=0 p_steal=0
# cgroup path (microseconds)
p_cg_usage_usec=0 p_cg_user_usec=0 p_cg_system_usec=0 p_cg_wall_usec=0
# shared
p_self_ticks=0
p_ts=0

# ── collector self-monitoring ──────────────────────────────
CLK_TCK=$(getconf CLK_TCK 2>/dev/null || echo 100)

read_self_cpu_ticks() {
  # /proc/self/stat: 14=utime 15=stime 16=cutime 17=cstime
  awk '{print $14+$15+$16+$17}' /proc/self/stat 2>/dev/null || echo 0
}

read_self_mem_mb() {
  awk '/^VmRSS:/ {printf "%.1f", $2/1024; exit}' /proc/self/status 2>/dev/null || echo 0
}

# ── helpers ────────────────────────────────────────────────

read_cpu_raw() {
  if ! read -r _ u n s i w q sq st _ < /proc/stat 2>/dev/null; then
    echo "0 0 0 0 0 0 0 0"
    return
  fi
  # ${st:-0}: steal column was added in Linux 2.6.11; absent on very old kernels
  echo "$u $n $s $i $w $q $sq ${st:-0}"
}

# Compute all CPU percentages in a single awk call (1 fork instead of 6)
# Output: user nice system idle iowait steal usage (7 values)
# Matches standard breakdown: user and nice are separate (like top/mpstat),
# system includes irq+softirq (like vmstat's sy column).
calc_cpu_pcts() {
  awk -v du="$1" -v dn="$2" -v ds="$3" -v di="$4" \
      -v dw="$5" -v dq="$6" -v dsq="$7" -v dst="$8" '
    BEGIN {
      dt = du+dn+ds+di+dw+dq+dsq+dst
      if (dt > 0) {
        printf "%.1f %.1f %.1f %.1f %.1f %.1f %.1f",
          du/dt*100, dn/dt*100, (ds+dq+dsq)/dt*100, di/dt*100,
          dw/dt*100, dst/dt*100, 100-di/dt*100
      } else {
        print "0.0 0.0 0.0 100.0 0.0 0.0 0.0"
      }
    }'
}

read_mem() {
  awk '
    /^MemTotal:/     {t=$2}
    /^MemAvailable:/ {a=$2}
    /^Buffers:/      {b=$2}
    /^Cached:/       {c=$2}
    /^SReclaimable:/ {sr=$2}
    /^SwapTotal:/    {swt=$2}
    /^SwapFree:/     {sf=$2}
    END {
      u=t-a; su=swt-sf
      # cached = Buffers + Cached + SReclaimable (matches `free` command)
      cached=b+c+sr
      mt=int(t/1024); mu=int(u/1024); ma=int(a/1024)
      mc=int(cached/1024); mst=int(swt/1024); msu=int(su/1024)
      if (mt > 0) mp=mu/mt*100; else mp=0
      printf "%d %d %d %d %d %d %.1f", mt,mu,ma,mc,mst,msu,mp
    }
  ' /proc/meminfo
}

# ── cgroup v2 helpers ────────────────────────────────────

read_cpu_cgroup_raw() {
  # Output: usage_usec user_usec system_usec wall_usec
  _cg_usage=0 _cg_user=0 _cg_sys=0
  while read -r _key _val; do
    case "$_key" in
      usage_usec)  _cg_usage=$_val ;;
      user_usec)   _cg_user=$_val ;;
      system_usec) _cg_sys=$_val ;;
    esac
  done < "$CG_CPU" 2>/dev/null
  echo "$_cg_usage $_cg_user $_cg_sys $(( $(date +%s) * 1000000 ))"
}

# calc_cpu_cgroup_pcts <d_usage> <d_user> <d_system> <d_wall>
# Output: user nice system idle iowait steal usage (7 values)
# nice=0, iowait=0, steal=0; idle derived from usage.
calc_cpu_cgroup_pcts() {
  awk -v du="$1" -v duser="$2" -v dsys="$3" -v dwall="$4" -v ncpu="$NUM_CPUS" '
    BEGIN {
      avail = dwall * ncpu
      if (avail > 0) {
        usage = du / avail * 100
        user  = duser / avail * 100
        sys   = dsys / avail * 100
      } else {
        usage = 0; user = 0; sys = 0
      }
      if (usage > 100) usage = 100
      if (user > 100)  user = 100
      if (sys > 100)   sys = 100
      idle = 100 - usage
      if (idle < 0) idle = 0
      printf "%.1f 0.0 %.1f %.1f 0.0 0.0 %.1f", user, sys, idle, usage
    }'
}

read_mem_cgroup() {
  # memory.current → used bytes
  _mem_cur=$(cat "$CG_MEM" 2>/dev/null || echo 0)

  # memory.stat → page cache (file) + reclaimable slab
  _mem_file=0 _mem_slab=0
  while read -r _key _val; do
    case "$_key" in
      file)             _mem_file=$_val ;;
      slab_reclaimable) _mem_slab=$_val ;;
    esac
  done < /sys/fs/cgroup/memory.stat 2>/dev/null

  # swap (may not exist)
  _swap_cur=$(cat /sys/fs/cgroup/memory.swap.current 2>/dev/null || echo 0)
  _swap_max=$(cat /sys/fs/cgroup/memory.swap.max 2>/dev/null || echo "max")
  case "$_swap_max" in max|'') _swap_max=0 ;; esac

  # total: memory.max if set, else /proc/meminfo MemTotal
  _mem_max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "max")
  case "$_mem_max" in
    max|'')
      _mem_max=$(awk '/^MemTotal:/ {print $2 * 1024; exit}' /proc/meminfo 2>/dev/null || echo 0)
      ;;
  esac

  # Output: total_mb used_mb available_mb cached_mb swap_total_mb swap_used_mb usage_pct
  awk -v cur="$_mem_cur" -v file="$_mem_file" -v slab="$_mem_slab" \
      -v swap="$_swap_cur" -v swmax="$_swap_max" -v total="$_mem_max" '
    BEGIN {
      mb = 1048576
      t = int(total / mb)
      cached = int((file + slab) / mb)
      u = int(cur / mb) - cached
      if (u < 0) u = 0
      a = t - u
      if (a < 0) a = 0
      su = int(swap / mb)
      st = int(swmax / mb)
      if (t > 0) mp = u / t * 100; else mp = 0
      printf "%d %d %d %d %d %d %.1f", t, u, a, cached, st, su, mp
    }'
}

read_load() { awk '{printf "%s %s %s",$1,$2,$3}' /proc/loadavg; }

maybe_rotate() {
  [ "$MAX_SIZE_MB" -eq 0 ] && return 0
  if [ -f "$OUT" ]; then
    # stat -c%s is GNU coreutils / busybox — fine for Linux runners
    size_bytes=$(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT")
    size_mb=$((size_bytes / 1048576))
    if [ "$size_mb" -ge "$MAX_SIZE_MB" ]; then
      # Keeps at most two files: current + one rotated backup.
      # The previous .1 is discarded to cap disk usage.
      mv -f "$OUT" "${OUT}.1"
    fi
  fi
}

# ── collect system info (once, before the loop) ─────────────
SYSINFO_FILE="$(dirname "$OUT")/sysinfo.json"

write_sysinfo() {
  # Single awk reads all info files + /proc/version for kernel.
  # ENVIRON[] pulls runner env vars without extra forks.
  _files="/proc/cpuinfo /proc/meminfo"
  [ -f /etc/os-release ] && _files="$_files /etc/os-release"
  [ -f /proc/version ]   && _files="$_files /proc/version"

  # shellcheck disable=SC2086
  awk -v msrc="$METRIC_SRC" '
    function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
    /^processor/   && FILENAME ~ /cpuinfo/     { cc++ }
    /^model name/  && FILENAME ~ /cpuinfo/ && !cm { sub(/^[^:]*:[ \t]*/, ""); cm = $0 }
    /^MemTotal:/   && FILENAME ~ /meminfo/     { tm = int($2/1024) }
    /^PRETTY_NAME=/ && FILENAME ~ /os-release/ { sub(/^PRETTY_NAME=/, ""); gsub(/"/, ""); or_ = $0 }
    /^Linux version/ && FILENAME ~ /version/   { kn = $3 }
    END {
      if (!cc) cc = 1;  if (!cm) cm = "unknown";  if (!tm) tm = 0
      if (!or_) or_ = "unknown";  if (!kn) kn = "unknown"
      rn = ENVIRON["RUNNER_NAME"];  if (!rn) rn = "unknown"
      ro = ENVIRON["RUNNER_OS"];    if (!ro) ro = "unknown"
      ra = ENVIRON["RUNNER_ARCH"];  if (!ra) ra = "unknown"
      printf "{\"cpu_count\":%d,\"cpu_model\":\"%s\",\"total_memory_mb\":%d,\"os_release\":\"%s\",\"kernel\":\"%s\",\"runner_name\":\"%s\",\"runner_os\":\"%s\",\"runner_arch\":\"%s\",\"metric_source\":\"%s\"}\n",
        cc, esc(cm), tm, esc(or_), esc(kn), esc(rn), esc(ro), esc(ra), msrc
    }
  ' $_files > "$SYSINFO_FILE"
}

write_sysinfo

# ── seed previous counters (first read is discarded) ───────
if [ "$METRIC_SRC" = "cgroup" ]; then
  set -- $(read_cpu_cgroup_raw)
  [ $# -eq 4 ] || { echo "ERROR: unexpected cgroup cpu.stat format" >&2; exit 1; }
  p_cg_usage_usec=$1 p_cg_user_usec=$2 p_cg_system_usec=$3 p_cg_wall_usec=$4
else
  set -- $(read_cpu_raw)
  [ $# -eq 8 ] || { echo "ERROR: unexpected /proc/stat format" >&2; exit 1; }
  p_user=$1 p_nice=$2 p_sys=$3 p_idle=$4 p_iow=$5 p_irq=$6 p_sirq=$7 p_steal=$8
fi
p_self_ticks=$(read_self_cpu_ticks)
p_ts=$(date +%s)

sleep "$INTERVAL" || true

# ── main loop ──────────────────────────────────────────────
while true; do
  ts=$(date +%s)

  # ── CPU (delta) ──────────────────────────────────────────
  if [ "$METRIC_SRC" = "cgroup" ]; then
    set -- $(read_cpu_cgroup_raw)
    if [ $# -ne 4 ]; then
      sleep "$INTERVAL" || true
      continue
    fi
    c_usage=$1 c_user=$2 c_sys=$3 c_wall=$4

    d_usage=$((c_usage - p_cg_usage_usec))
    d_user=$((c_user  - p_cg_user_usec))
    d_sys=$((c_sys    - p_cg_system_usec))
    d_wall=$((c_wall  - p_cg_wall_usec))

    set -- $(calc_cpu_cgroup_pcts $d_usage $d_user $d_sys $d_wall)
    if [ $# -ne 7 ]; then
      sleep "$INTERVAL" || true
      continue
    fi
    cpu_u=$1 cpu_n=$2 cpu_s=$3 cpu_id=$4 cpu_w=$5 cpu_st=$6 cpu_pct=$7

    p_cg_usage_usec=$c_usage p_cg_user_usec=$c_user
    p_cg_system_usec=$c_sys  p_cg_wall_usec=$c_wall
  else
    set -- $(read_cpu_raw)
    if [ $# -ne 8 ]; then
      sleep "$INTERVAL" || true
      continue
    fi
    cu=$1 cn=$2 cs=$3 ci=$4 cw=$5 cq=$6 csq=$7 cst=$8

    du=$((cu - p_user))  dn=$((cn - p_nice))
    ds=$((cs - p_sys))   di=$((ci - p_idle))
    dw=$((cw - p_iow))   dq=$((cq - p_irq))
    dsq=$((csq - p_sirq)) dst=$((cst - p_steal))

    set -- $(calc_cpu_pcts $du $dn $ds $di $dw $dq $dsq $dst)
    if [ $# -ne 7 ]; then
      sleep "$INTERVAL" || true
      continue
    fi
    cpu_u=$1 cpu_n=$2 cpu_s=$3 cpu_id=$4 cpu_w=$5 cpu_st=$6 cpu_pct=$7

    p_user=$cu p_nice=$cn p_sys=$cs p_idle=$ci
    p_iow=$cw  p_irq=$cq  p_sirq=$csq p_steal=$cst
  fi

  # ── Memory ──────────────────────────────────────────────
  if [ "$METRIC_SRC" = "cgroup" ]; then
    set -- $(read_mem_cgroup)
  else
    set -- $(read_mem)
  fi
  if [ $# -ne 7 ]; then
    sleep "$INTERVAL" || true
    continue
  fi
  mt=$1 mu=$2 ma=$3 mc=$4 stt=$5 su=$6 mp=$7

  # ── Load ────────────────────────────────────────────────
  set -- $(read_load)
  if [ $# -ne 3 ]; then
    sleep "$INTERVAL" || true
    continue
  fi
  l1=$1 l5=$2 l15=$3

  # ── Collector self-monitoring ────────────────────────────
  c_self_ticks=$(read_self_cpu_ticks)
  c_self_delta=$((c_self_ticks - p_self_ticks))
  if [ "$c_self_delta" -lt 0 ]; then c_self_delta=0; fi
  # Use real wall-clock elapsed time instead of $INTERVAL to account for drift
  elapsed=$((ts - p_ts))
  if [ "$elapsed" -le 0 ]; then elapsed=$INTERVAL; fi
  c_self_cpu=$(awk -v d="$c_self_delta" -v hz="$CLK_TCK" -v i="$elapsed" \
    'BEGIN { v=d/(hz*i)*100; if(v>100)v=100; printf "%.1f",v }')
  c_self_mem=$(read_self_mem_mb)
  p_self_ticks=$c_self_ticks
  p_ts=$ts

  # ── Rotate if needed, then emit JSONL line ──────────────
  maybe_rotate

  printf '%s\n' \
    "{\"timestamp\":${ts},\"cpu\":{\"user\":${cpu_u},\"nice\":${cpu_n},\"system\":${cpu_s},\"idle\":${cpu_id},\"iowait\":${cpu_w},\"steal\":${cpu_st},\"usage\":${cpu_pct}},\"memory\":{\"total_mb\":${mt},\"used_mb\":${mu},\"available_mb\":${ma},\"cached_mb\":${mc},\"swap_total_mb\":${stt},\"swap_used_mb\":${su},\"usage_pct\":${mp}},\"load\":{\"load1\":${l1},\"load5\":${l5},\"load15\":${l15}},\"collector\":{\"cpu_pct\":${c_self_cpu},\"mem_mb\":${c_self_mem}}}" >> "$OUT"

  sleep "$INTERVAL" || true
done
