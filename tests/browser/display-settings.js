async (page) => {
  const base = 'http://127.0.0.1:9958';
  const errors = [], preferenceWrites = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/api/ui/settings') && request.method() === 'PATCH') preferenceWrites.push(request.postDataJSON());
  });
  await page.setViewportSize({ width: 1120, height: 850 });
  await page.goto(`${base}/settings#display`);
  await page.evaluate(() => localStorage.removeItem('liuwa.display'));
  await page.reload();
  await page.locator('#liuwaReadingFontSize').waitFor();
  const fontSize = selector => page.locator(selector).evaluate(node => getComputedStyle(node).fontSize);
  if (await fontSize('.appearance-reading') !== '18px') throw Error('Default reading font is not 18px');
  await page.locator('#liuwaReadingFontSize').selectOption('24');
  if (await fontSize('.appearance-reading') !== '24px') throw Error('Reading preview did not update');
  if (await fontSize('.appearance-reading code') !== '21px') throw Error('Code does not scale with reading size');
  await page.locator('#liuwaZoom').selectOption('1.6');
  if (await page.evaluate(() => getComputedStyle(document.documentElement).zoom) !== '1.6') throw Error('Browser zoom preview did not update');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#liuwaReadingFontSize').value === '24' && document.querySelector('#liuwaZoom').value === '1.6');
  await page.setViewportSize({ width: 520, height: 760 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Small desktop settings overflow at 160%');
  await page.locator('#liuwaZoom').selectOption('0.7');
  if (await page.locator('#liuwaReadingFontSize').inputValue() !== '24') throw Error('Zoom changed independent reading size');
  await page.locator('#liuwaDisplayReset').click();
  if (await fontSize('.appearance-reading') !== '18px' || await page.locator('#liuwaZoom').inputValue() !== '1') throw Error('Restore defaults failed');
  await page.setViewportSize({ width: 375, height: 812 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile display controls overflow');
  if (await page.locator('#settingsSavebar').isVisible()) throw Error('Appearance exposes an unrelated save bar');
  if (preferenceWrites.length) throw Error('Display settings overwrote gateway preferences');
  if (errors.length) throw Error(errors.join(';'));
  return { defaultReadingSize: 18, readingAndCodeScale: true, zoomIndependent: true, localPersistence: true, extremeZoomFitsSmallDesktop: true, resetDefaults: true, preferenceWrites: 0, errors };
}
