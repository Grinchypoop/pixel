/**
 * Screenshotter utility — uses Puppeteer to capture browser errors.
 * Gracefully disabled when Puppeteer is unavailable (CI / restricted envs).
 */

export interface ScreenshotResult {
  base64: string;
  consoleErrors: string[];
  pageTitle: string;
}

export async function captureScreenshot(
  url: string,
  waitMs = 3000,
): Promise<ScreenshotResult | null> {
  let puppeteer: typeof import('puppeteer');

  try {
    puppeteer = await import('puppeteer');
  } catch {
    console.warn('[Screenshotter] Puppeteer not available — skipping screenshot');
    return null;
  }

  let browser: import('puppeteer').Browser | undefined;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 20_000 });
    await new Promise((r) => setTimeout(r, waitMs));

    const screenshotBuffer = (await page.screenshot({
      fullPage: true,
      type: 'png',
    })) as Buffer;

    const pageTitle = await page.title();

    return {
      base64: screenshotBuffer.toString('base64'),
      consoleErrors,
      pageTitle,
    };
  } catch (err) {
    console.warn('[Screenshotter] Failed to capture screenshot:', err);
    return null;
  } finally {
    await browser?.close();
  }
}
