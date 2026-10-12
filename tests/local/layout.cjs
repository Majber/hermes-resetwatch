const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
assert.ok(process.env.RESETWATCH_FIXTURE_HTML, 'Run compact.cjs with RESETWATCH_FIXTURE_HTML first');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}),args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1100,height:700}});
  await page.goto(pathToFileURL(process.env.RESETWATCH_FIXTURE_HTML).href);
  const measure=()=>page.evaluate(()=>{
   const rows=[...document.querySelectorAll('tr[data-account-row]')];
   const table=document.querySelector('[data-account-overview]');
   return {rows:rows.length,allVisible:rows.every(row=>{const r=row.getBoundingClientRect();return r.top>=0&&r.bottom<=window.innerHeight}),rowHeights:rows.map(row=>row.getBoundingClientRect().height),tableHeight:table.getBoundingClientRect().height,lastRowBottom:rows.at(-1).getBoundingClientRect().bottom,collapsed:document.querySelectorAll('[data-account-toggle][aria-expanded="false"]').length,detailsOpen:document.querySelectorAll('details[open]').length,horizontalScroll:table.scrollWidth>table.clientWidth,bodyOverflow:document.documentElement.scrollWidth>window.innerWidth};
  });
  const desktop=await measure();
  assert.equal(desktop.rows,7);assert.equal(desktop.allVisible,true);assert.equal(desktop.collapsed,7);assert.equal(desktop.detailsOpen,0);assert.ok(desktop.lastRowBottom<=620);assert.ok(desktop.tableHeight<=550);assert.equal(desktop.bodyOverflow,false);
  await page.setViewportSize({width:420,height:700});
  const narrow=await measure();
  assert.equal(narrow.rows,7);assert.equal(narrow.horizontalScroll,true);assert.equal(narrow.bodyOverflow,false);assert.equal(narrow.allVisible,true);assert.ok(narrow.tableHeight<=550);
  await page.locator('[data-account-overview]').evaluate(node=>node.scrollLeft=node.scrollWidth);
  const right=await page.locator('[data-account-toggle]').last().boundingBox();assert.ok(right.x>=0&&right.x+right.width<=420);
  console.log(JSON.stringify({desktop,narrow},null,2));
  console.log('PASS browser fixture: all seven rows visible with accepted larger typography; collapsed details/help/providers; narrow horizontal scrolling without page overflow');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
