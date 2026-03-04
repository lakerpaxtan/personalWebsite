#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const rawTarget = process.argv[2] || "http://localhost:4000";
const target = normalizeTarget(rawTarget);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve("artifacts", "ui-check", runId);
const summaryFile = path.join(outputDir, "summary.json");
const PORTFOLIO_SECTION = "section#portfolio.bg-light-gray";

const state = {
  target,
  runId,
  checks: [],
  failures: []
};

function normalizeTarget(input) {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  if (input.startsWith("127.0.0.1") || input.startsWith("localhost")) {
    return `http://${input}`;
  }
  return `https://${input}`;
}

function addCheck(name, passed, details) {
  const result = { name, passed, details };
  state.checks.push(result);
  if (!passed) {
    state.failures.push(result);
  }
}

function expectedColumns(width) {
  if (width >= 992) {
    return 3;
  }
  if (width >= 768) {
    return 2;
  }
  return 1;
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await safelyRun("mobile-timeline", () => checkMobileTimeline(page));
    await safelyRun("portfolio-resizing", () => checkPortfolioResizing(page));
    await safelyRun("portfolio-clickability", () => checkPortfolioModalClickability(page));
  } finally {
    await browser.close();
  }

  await fs.writeFile(summaryFile, `${JSON.stringify(state, null, 2)}\n`);
  printSummary();
  process.exitCode = state.failures.length > 0 ? 1 : 0;
}

async function safelyRun(label, operation) {
  try {
    await operation();
  } catch (error) {
    addCheck(`${label}-runtime`, false, {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function loadTarget(page) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(900);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await page.waitForTimeout(1000);
      }
    }
  }
  throw lastError;
}

async function checkMobileTimeline(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadTarget(page);
  await page.waitForSelector(".timeline .timeline-image img", { timeout: 20000 });
  await page.locator("#about").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);

  const timelineImages = await page.$$eval(".timeline .timeline-image img", (images) =>
    images.map((image, index) => {
      const rect = image.getBoundingClientRect();
      const naturalWidth = image.naturalWidth || 0;
      const naturalHeight = image.naturalHeight || 1;
      const renderedWidth = rect.width;
      const renderedHeight = rect.height || 1;

      return {
        index,
        naturalWidth,
        naturalHeight,
        naturalRatio: Number((naturalWidth / naturalHeight).toFixed(3)),
        renderedWidth: Number(renderedWidth.toFixed(3)),
        renderedHeight: Number(renderedHeight.toFixed(3)),
        renderedRatio: Number((renderedWidth / renderedHeight).toFixed(3)),
        ratioDelta: Number(Math.abs(renderedWidth / renderedHeight - naturalWidth / naturalHeight).toFixed(3)),
        objectFit: window.getComputedStyle(image).objectFit || "none"
      };
    })
  );

  const likelySquashed = timelineImages.filter((image) => image.ratioDelta > 0.12);
  await page.screenshot({
    path: path.join(outputDir, "mobile-timeline.png"),
    fullPage: true
  });

  addCheck("mobile-timeline-image-aspect", likelySquashed.length === 0, {
    totalImages: timelineImages.length,
    likelySquashedCount: likelySquashed.length,
    likelySquashed: likelySquashed.slice(0, 6)
  });
}

async function checkPortfolioResizing(page) {
  const widths = [1500, 1280, 1100, 992, 991, 850, 767];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1500 });
    await loadTarget(page);
    await page.waitForSelector(`${PORTFOLIO_SECTION} .portfolio-item`, { timeout: 20000 });
    await page.locator(PORTFOLIO_SECTION).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);

    const layout = await page.$$eval("section#portfolio.bg-light-gray .portfolio-item", (items) => {
      const entries = items
        .map((item, index) => {
          const rect = item.getBoundingClientRect();
          return {
            index,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          };
        })
        .filter((entry) => entry.width > 0 && entry.height > 0)
        .sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top));

      const rows = [];
      const tolerance = 8;
      for (const entry of entries) {
        let row = rows.find((candidate) => Math.abs(candidate.top - entry.top) <= tolerance);
        if (!row) {
          row = { top: entry.top, items: [] };
          rows.push(row);
        }
        row.items.push(entry);
      }

      rows.sort((a, b) => a.top - b.top);

      return {
        itemCount: entries.length,
        rowCounts: rows.map((row) => row.items.length),
        rows: rows.map((row) => ({
          top: Number(row.top.toFixed(1)),
          count: row.items.length
        }))
      };
    });

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    }));

    await page.screenshot({
      path: path.join(outputDir, `portfolio-${width}.png`),
      fullPage: true
    });

    const expected = expectedColumns(width);
    const rowFailures = [];

    for (let i = 0; i < layout.rowCounts.length; i += 1) {
      const count = layout.rowCounts[i];
      const isLast = i === layout.rowCounts.length - 1;
      if (!isLast && count !== expected) {
        rowFailures.push({
          rowIndex: i + 1,
          count,
          expected
        });
      }
      if (count > expected) {
        rowFailures.push({
          rowIndex: i + 1,
          count,
          expected,
          reason: "row overflow"
        });
      }
    }

    addCheck(`portfolio-row-consistency-${width}px`, rowFailures.length === 0, {
      expectedColumns: expected,
      rowCounts: layout.rowCounts,
      rowFailures
    });

    addCheck(`horizontal-overflow-${width}px`, !overflow.hasOverflow, overflow);
  }
}

async function checkPortfolioModalClickability(page) {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await loadTarget(page);
  await page.waitForSelector(`${PORTFOLIO_SECTION} .portfolio-link`, { timeout: 20000 });
  await page.locator(PORTFOLIO_SECTION).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);

  const links = page.locator(`${PORTFOLIO_SECTION} .portfolio-link`);
  const total = await links.count();
  const attempts = Math.min(total, 4);
  const failures = [];

  for (let index = 0; index < attempts; index += 1) {
    const link = links.nth(index);
    await link.scrollIntoViewIfNeeded();
    const href = await link.getAttribute("href");
    const modalSelector = href ? `${href}.in` : ".portfolio-modal.in";

    await link.click();
    try {
      await page.waitForSelector(modalSelector, { state: "visible", timeout: 4000 });
    } catch {
      failures.push({ index, reason: "modal did not open" });
      continue;
    }

    const closeButton = page.locator(`${modalSelector} .close-modal`);
    await closeButton.click({ force: true });
    await page.waitForSelector(modalSelector, { state: "hidden", timeout: 4000 });
    await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 4000 });
  }

  await page.screenshot({
    path: path.join(outputDir, "portfolio-clickability.png"),
    fullPage: true
  });

  addCheck("portfolio-modal-clickability", failures.length === 0, {
    attemptedLinks: attempts,
    failures
  });
}

function printSummary() {
  console.log(`Target: ${state.target}`);
  console.log(`Artifacts: ${outputDir}`);
  console.log("");

  for (const check of state.checks) {
    const marker = check.passed ? "PASS" : "FAIL";
    console.log(`${marker} ${check.name}`);
  }

  console.log("");
  console.log(
    state.failures.length === 0
      ? "All checks passed."
      : `${state.failures.length} check(s) failed. See ${summaryFile} for details.`
  );
}

await run();
