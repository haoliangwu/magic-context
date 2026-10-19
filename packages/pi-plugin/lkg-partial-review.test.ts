import { test, expect, spyOn } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestTempDirFromPath } from '../../packages/plugin/src/shared/test-temp-dir';
import * as cleanup from '../../packages/pi-plugin/src/heuristic-cleanup-pi';
import { getTagsBySession, updateSessionMeta } from '../../packages/plugin/src/features/magic-context/storage';
import { __test, registerPiContextHandler, clearContextHandlerSession, signalPiPendingMaterialization } from '../../packages/pi-plugin/src/context-handler';
import { createTestDb, createFakePi, fakeContext, userMessage, assistantToolCall, toolResultMessage, assistantMessage } from '../../packages/pi-plugin/src/test-utils.test';

for (const position of [0,1,2]) test(`cache review partial-commit LKG: position ${position+1} cannot first-apply an unserved durable drop on warm restart`, async()=>{
 const root=createTestTempDirFromPath(join(tmpdir(),'lkg-partial-review-'));
 const path=join(root,'fixture.db'); let db=createTestDb(path);
 const session='partial-lkg-review', fake=createFakePi();
 Object.assign(fake.pi,{getActiveTools:()=>[], getAllTools:()=>[]});
 registerPiContextHandler(fake.pi as never,{db,protectedTokens:0,protectedTags:0,heuristics:{},scheduler:{executeThresholdPercentage:65}});
 let handler=fake.handlers.get('context') as any;
 const build=()=>[userMessage('start',1),...Array.from({length:6},(_,i)=>[assistantToolCall(`reduce-${i}`,'ctx_reduce',{},100+i*2),{...toolResultMessage(`reduce-${i}`,'r'.repeat(20000),101+i*2),toolName:'ctx_reduce'}]).flat(),assistantMessage('answered',200),userMessage('continue',201)];
 let tokens=1000;
 const pass=async()=>{const messages=build();return handler({messages},{...fakeContext(session,process.cwd(),messages.map(m=>`entry-${m.timestamp}`),messages),getSystemPrompt:()=> 'isolated system',model:{provider:'anthropic',id:'claude-sonnet-4',api:'anthropic-messages',contextWindow:100000},getContextUsage:()=>({tokens,percent:tokens/1000,contextWindow:100000})});};
 const warm=()=>updateSessionMeta(db,session,{lastResponseTime:Date.now(),cacheTtl:'59m',lastContextPercentage:1,lastInputTokens:1000});
 try{
  // Start with only three exemplars, then publish six raw arcs on a defer pass.
  const originalBuild=build;
  const initial=originalBuild(); initial.splice(7,6);
  await handler({messages:initial},{...fakeContext(session,process.cwd(),initial.map(m=>`entry-${m.timestamp}`),initial),getSystemPrompt:()=> 'isolated system',model:{provider:'anthropic',id:'claude-sonnet-4',api:'anthropic-messages',contextWindow:100000},getContextUsage:()=>({tokens:1000,percent:1,contextWindow:100000})});
  warm(); const before=await pass(); warm();
  const tags=getTagsBySession(db,session).filter(t=>t.type==='tool');
  db.exec(`CREATE TEMP TRIGGER review_abort BEFORE UPDATE OF status ON tags WHEN NEW.tag_number=${tags[position].tagNumber} AND NEW.status='dropped' BEGIN SELECT RAISE(ABORT,'partial lkg fault'); END`);
  signalPiPendingMaterialization(session);
  let result:any, error:any;
  try {result=await pass();}catch(e){error=e;}
  console.log('PARTIAL_LKG_REVIEW',JSON.stringify({returned:!!result,error:error?.message,statuses:getTagsBySession(db,session).filter(t=>t.type==='tool').map(t=>[t.status,t.dropMode]),returnedPrior:result&&JSON.stringify(result.messages)===JSON.stringify(before.messages),returnedOldCall:result&&JSON.stringify(result.messages).includes('"id":"reduce-0"')}));
  const spy = spyOn(cleanup,'applyPiHeuristicCleanup'); tokens=1000; warm();
  let next:any, nextError:any; try { next=await pass(); } catch(e) {nextError=e;}
  console.log('PARTIAL_LKG_NEXT',JSON.stringify({returned:!!next,error:nextError?.message,scans:spy.mock.calls.length,oldCall:next&&JSON.stringify(next.messages).includes('"id":"reduce-0"'),equalRecovery:next&&result&&JSON.stringify(next.messages)===JSON.stringify(result.messages),equalPrior:next&&JSON.stringify(next.messages)===JSON.stringify(before.messages),statuses:getTagsBySession(db,session).filter(t=>t.type==='tool').map(t=>[t.status,t.dropMode])})); spy.mockRestore();
  clearContextHandlerSession(session); db.close(); db=createTestDb(path);
  registerPiContextHandler(fake.pi as never,{db,protectedTokens:0,protectedTags:0,heuristics:{},scheduler:{executeThresholdPercentage:65}});
  handler=fake.handlers.get('context') as any; warm();
  const restartSpy=spyOn(cleanup,'applyPiHeuristicCleanup');
  let gate:any; const releaseGate=__test.setMutationGateObserverForTests(s=>{gate=s;});
  let restarted:any, restartError:any; try {restarted=await pass();}catch(e){restartError=e;}
  console.log('PARTIAL_LKG_RESTART',JSON.stringify({gate,returned:!!restarted,error:restartError?.message,scans:restartSpy.mock.calls.length,oldCall:restarted&&JSON.stringify(restarted.messages).includes('"id":"reduce-0"'),equalPrior:restarted&&JSON.stringify(restarted.messages)===JSON.stringify(before.messages)}));restartSpy.mockRestore();releaseGate();
  expect(result).toBeDefined();
  expect(restarted).toBeDefined();
  expect(gate).toEqual({foldDue:false,foldExecuted:false,foldBustsServedPrefix:false,shouldApplyPendingOps:false,shouldRunHeuristics:false,shouldRunReasoningCleanup:false});
  expect(JSON.stringify(restarted.messages)).toBe(JSON.stringify(result.messages));
 }finally{clearContextHandlerSession(session);db.close();rmSync(root,{recursive:true,force:true});}
});
