let hub = false;
page.on('request', (r) => { if ((r.postData() || '').includes('MsgSpecialMessageListReq')) hub = true; });
await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input', { timeout: 180000 });
const ins = await page.$$('input');
await ins[0].fill('damissi'); await ins[1].fill('offline'); await ins[1].press('Enter');
for (let i = 0; i < 120 && !hub; i++) await sleep(2000);
await sleep(8000);
for (let i = 0; i < 3; i++) { await page.mouse.click(1240, 103); await sleep(2500); }
await page.mouse.click(640, 590); await sleep(2000);
await page.mouse.click(1030, 640); await sleep(15000);
await page.mouse.click(350, 612); await sleep(3000);
await page.mouse.click(968, 468); await sleep(3000);
return hub;
