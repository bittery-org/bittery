# Extension E2E Tests

This directory contains end-to-end tests for the Bittery browser extension using Playwright.

## Test Coverage

### Save Login Prompt Feature (`save-login-prompt.spec.ts`)

Comprehensive tests for the extension's ability to detect and save login credentials.

**Test Cases:**

1. **T019: Duplicate Detection and Update Flow**
   - Tests detecting duplicate credentials for the same site
   - Verifies "Update existing" and "Save new" options appear
   - Tests updating existing credentials with new password

2. **T020: Vault Selection with Multiple Vaults**
   - Tests vault selector dropdown functionality
   - Verifies multiple vaults are displayed
   - Tests saving to different vaults

3. **T021: Security Tests**
   - Verifies credentials are NOT saved when extension is locked
   - Verifies credentials are encrypted before storage
   - Tests that raw passwords don't appear in storage

4. **Additional Tests**
   - Form submission detection (traditional submit, Enter key)
   - Cancel flow
   - Error handling

## Prerequisites

Before running tests:

1. **Build the extension:**
   ```bash
   pnpm run build
   ```

2. **Start the database:**
   ```bash
   # From repository root
   pnpm run db:start
   ```

3. **Start the server (optional - auto-started):**
   ```bash
   # From repository root
   pnpm run dev:server
   ```

4. **Start the web app (optional - auto-started):**
   ```bash
   # From repository root
   cd apps/web && pnpm run dev
   ```

## Running Tests

### Run all tests
```bash
pnpm run test:e2e
```

### Run with Playwright UI (interactive mode)
```bash
pnpm run test:e2e:ui
```

### Run in headed mode (see the browser)
```bash
pnpm run test:e2e:headed
```

### Run in debug mode
```bash
pnpm run test:e2e:debug
```

### Run specific test file
```bash
npx playwright test save-login-prompt.spec.ts
```

### Run specific test case
```bash
npx playwright test -g "T019"
```

## Test Architecture

### Extension Loading

Tests load the built extension into a Chromium browser context:

```typescript
const pathToExtension = path.resolve(__dirname, "../../dist");
context = await browser.newContext({
  launchOptions: {
    args: [
      `--disable-extensions-except=${pathToExtension}`,
      `--load-extension=${pathToExtension}`,
    ],
  },
});
```

### Authentication Flow

Tests automatically set up authentication by:
1. Navigating to the web app
2. Creating/logging in with a test user
3. Creating test vaults
4. Unlocking the extension

### Save Prompt Testing

The save prompt is injected as an iframe, which is accessed using Playwright's `frameLocator`:

```typescript
const savePrompt = page.frameLocator('iframe[src*="save-prompt-iframe.html"]');
await savePrompt.locator('button:has-text("Save")').click();
```

## Debugging Tests

### View test report
```bash
npx playwright show-report
```

### Enable debug logs
Set the `DEBUG` environment variable:
```bash
DEBUG=pw:api pnpm run test:e2e
```

### Take screenshots
Playwright automatically captures screenshots on failure. You can also manually capture:
```typescript
await page.screenshot({ path: 'debug.png' });
```

### Slow motion
Run tests in slow motion to see what's happening:
```bash
npx playwright test --headed --slow-mo=1000
```

## Test Data

Tests use isolated test data:
- **Test user:** `test-extension-save@bittery.test`
- **Test vaults:** Auto-created during test setup
- **Test credentials:** Unique per test to avoid conflicts

## Known Issues

- Extension tests must run sequentially (`workers: 1`) to avoid conflicts
- Some tests may be flaky due to timing - adjust timeouts if needed
- Extension popup requires explicit unlocking in tests

## CI/CD Integration

Tests are configured to run in CI with:
- 2 retries on failure
- Video recording on failure
- Screenshot capture on failure
- Headless mode by default

## Adding New Tests

1. Create test file in `tests/e2e/`
2. Import Playwright test utilities
3. Set up browser context with extension loaded
4. Write test cases following existing patterns
5. Update this README with new test coverage

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Testing Chrome Extensions](https://playwright.dev/docs/chrome-extensions)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
