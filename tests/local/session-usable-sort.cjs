const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../../resetwatch-local/plugin.js'),'utf8');
const ctx={normalizeAccountSort:x=>x,deriveAccountStatus:s=>({historical:!!s.old,availability:s.weekly===0||s.session===0?'limit_reached':'available'}),mainQuotaWindows:s=>[{label:'Session',remaining_percent:s.session},{label:'Weekly',remaining_percent:s.weekly}],quotaPercent:x=>x.remaining};
vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function sortAccounts('),source.indexOf('function AccountSortControls(')),ctx);
const rows=new Map([['blocked',{snap:{session:100,weekly:0}}],['low',{snap:{session:20,weekly:40}}],['high',{snap:{session:80,weekly:60}}],['old',{snap:{session:100,weekly:90,old:true}}]]);
assert.deepEqual(Array.from(ctx.sortAccounts(rows,{key:'session',direction:'desc'},0),r=>r[0]),['high','low','blocked','old']);
assert.deepEqual(Array.from(ctx.sortAccounts(rows,{key:'session',direction:'asc'},0),r=>r[0]),['low','high','blocked','old']);
assert.deepEqual(Array.from(ctx.sortAccounts(rows,{key:'default'},0),r=>r[0]),Array.from(rows.keys()));
console.log('PASS: usable accounts first in both directions; stale last; original order unchanged');
