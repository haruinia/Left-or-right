async (page) => {
  const stylesheet = await page.request.get('http://127.0.0.1:9958/styles.css', { headers: { 'user-agent': 'Left-or-right UI test' } });
  if (!stylesheet.ok()) throw new Error('Start the gateway on 9958 before running this test.');
  await page.setViewportSize({width:600,height:500});
  await page.setContent('<html class="liuwa-host"><body class="liuwa-page liuwa-shell"><main class="liuwa-orb"><nav class="liuwa-command-bar"><button type="button" id="gateCapture">截图</button><details class="liuwa-display"><summary id="gateSettings">设置</summary></details></nav></main></body></html>');
  await page.addStyleTag({content:await stylesheet.text()});
  await page.evaluate(() => {
    window.__gateClicks = 0;
    document.querySelector('#gateCapture').addEventListener('click', () => { window.__gateClicks += 1; });
  });

  const button = page.locator('#gateCapture');
  const color = () => button.evaluate(e => getComputedStyle(e).backgroundColor);
  const point = async () => {
    const box = await button.boundingBox();
    return {x:box.x + box.width / 2,y:box.y + box.height / 2};
  };
  await page.mouse.move(590,490);
  const idleColor = await color();
  let center = await point();
  await page.mouse.move(center.x,center.y);
  await page.mouse.click(center.x,center.y);
  if (await color() !== idleColor) throw new Error('An unarmed overlay still changes on hover.');
  if (await page.evaluate(() => window.__gateClicks) !== 0) throw new Error('An unarmed overlay received a click.');
  if (await button.evaluate(e => getComputedStyle(e).pointerEvents) !== 'none') throw new Error('Unarmed hit testing was not disabled.');

  await page.evaluate(() => document.body.classList.add('liuwa-armed'));
  await page.mouse.move(590,490);
  await button.hover();
  await page.waitForFunction(idle => getComputedStyle(document.querySelector('#gateCapture')).backgroundColor !== idle,idleColor);
  await button.click();
  if (await page.evaluate(() => window.__gateClicks) !== 1) throw new Error('An armed overlay did not receive its click.');

  const released = await page.evaluate(() => {
    document.body.classList.remove('liuwa-armed');
    const style = getComputedStyle(document.querySelector('#gateCapture'));
    return {color:style.backgroundColor,pointerEvents:style.pointerEvents,transitionDuration:style.transitionDuration};
  });
  if (released.color !== idleColor) throw new Error('Releasing Command left the existing hover visible.');
  if (released.pointerEvents !== 'none' || released.transitionDuration !== '0s') throw new Error('The released overlay is not immediately inert.');
  center = await point();
  await page.mouse.click(center.x,center.y);
  if (await page.evaluate(() => window.__gateClicks) !== 1) throw new Error('A released overlay still received a click.');

  await page.evaluate(() => document.documentElement.classList.remove('liuwa-host'));
  await page.mouse.move(590,490);
  await button.hover();
  await page.waitForFunction(idle => getComputedStyle(document.querySelector('#gateCapture')).backgroundColor !== idle,idleColor);
  await button.click();
  if (await page.evaluate(() => window.__gateClicks) !== 2) throw new Error('The browser-only page stopped accepting clicks.');
  if (await button.evaluate(e => getComputedStyle(e).pointerEvents) === 'none') throw new Error('The desktop gate leaked into a browser-only page.');
  return {unarmedHover:false,unarmedClick:false,armedHover:true,armedClick:true,releaseClearsHoverImmediately:true,browserHoverAndClick:true};
}
