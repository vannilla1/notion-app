module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'services/**/*.js',
    'routes/**/*.js',
    'models/**/*.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  testTimeout: 30000,
  verbose: true,
  // Niektoré moduly (napr. routes/push.js, services/dueDateChecker.js, services/
  // subscriptionCleanup.js) si pri require registrujú setInterval pre
  // periodický cleanup. V teste nie je spôsob ich vypnúť bez refaktoru, takže
  // necháme Jest forcnuť exit — inak by proces visel po dokončení testov.
  forceExit: true
};
