/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testPathIgnorePatterns: ['/node_modules/', 'preview-gen'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/post.ts'],
  // Ratcheted up to just under the current numbers so coverage can't silently
  // regress. Raise these alongside any real increase.
  coverageThreshold: {
    global: { branches: 75, functions: 92, lines: 93, statements: 92 },
  },
  moduleNameMapper: {
    '^@actions/artifact$': '<rootDir>/node_modules/@actions/artifact/lib/artifact.js',
  },
};
