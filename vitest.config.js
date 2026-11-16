import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            // app/vendor/ holds pre-bundled third-party artifacts (#343), not
            // code we write or test, which would otherwise count as untested
            // lines. Spread the defaults so excluding them doesn't drop vitest's
            // built-in exclusions (node_modules, test files, configs).
            exclude: [...coverageConfigDefaults.exclude, 'app/vendor/**'],
        },
    },
});
