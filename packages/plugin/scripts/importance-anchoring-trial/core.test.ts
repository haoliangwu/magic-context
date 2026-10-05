import { describe, expect, test } from "bun:test";
import { alterSessionScores, band, distribution, plantedScores, scores, selectD, variantD, variantE, type HistoricalReference } from "./core";
const ref=(importance:number,sequence:number):HistoricalReference=>({id:sequence,sequence,startMessage:sequence*10,endMessage:sequence*10+9,title:`ref ${sequence}`,importance,content:"content",p1:"one",p2:"two",p3:"three",p4:"four"});
const prompt='<compartment_examples_from_other_projects><compartment importance="96">seed</compartment></compartment_examples_from_other_projects>\n<session_references><compartment title="reference" importance="74"><p1>importance="77" in prose</p1></compartment></session_references>\n<new_messages>importance="88" transcript</new_messages>';
describe("paired reference manipulations",()=>{
    test("B removes only session compartment attributes, not seed or transcript or p1 prose",()=>{
        expect(alterSessionScores(prompt)).toBe('<compartment_examples_from_other_projects><compartment importance="96">seed</compartment></compartment_examples_from_other_projects>\n<session_references><compartment title="reference"><p1>importance="77" in prose</p1></compartment></session_references>\n<new_messages>importance="88" transcript</new_messages>');
    });
    test("C replaces only session compartment attributes",()=>{
        expect(alterSessionScores(prompt,[3])).toBe(prompt.replace('title="reference" importance="74"','title="reference" importance="3"'));
    });
    test("planting is repeatable and draws fixed seed scores across the full range",()=>{
        expect(plantedScores("literal",60)).toEqual(plantedScores("literal",60));
        expect(Math.min(...plantedScores("literal",60))).toBe(3);
        expect(Math.max(...plantedScores("literal",60))).toBe(96);
        expect(plantedScores("literal",6).length).toBe(6);
    });
    test("band edges are inclusive and identical to production",()=>{
        expect([1,9,10,29,30,59,60,84,85,100].map(band)).toEqual([4,4,3,3,2,2,1,1,0,0]);
    });
    test("D has three seeds plus three diverse older and four recent, preserving chronology",()=>{
        const history=[ref(4,0),ref(15,1),ref(40,2),ref(90,3),ref(65,4),ref(65,5),ref(65,6),ref(65,7)];
        const d=variantD(prompt,history,"session",80);
        expect(d.selected.seeds).toHaveLength(3);
        expect(d.selected.recent.map(r=>r.sequence)).toEqual([4,5,6,7]);
        expect(d.selected.diverse).toHaveLength(3);
        const picked=d.selected.diverse.map(r=>r.sequence);
        expect(picked).toEqual([...picked].sort((a,b)=>a-b));
        expect(picked.every(i=>i<4)).toBe(true);
        const seedBlock=d.prompt.match(/<compartment_examples_from_other_projects>[\s\S]*?<\/compartment_examples_from_other_projects>/)![0];
        const refBlock=d.prompt.match(/<session_references>[\s\S]*?<\/session_references>/)![0];
        expect(seedBlock.match(/<compartment /g)).toHaveLength(3);
        expect(refBlock.match(/<compartment /g)).toHaveLength(7);
        expect(d.prompt.split('<new_messages>')[1]).toBe('importance="88" transcript</new_messages>');
    });
    test("D covers available uncovered bands first and fills least-represented available bands",()=>{
        const history=[ref(3,0),ref(15,1),ref(35,2),ref(90,3),ref(65,4),ref(65,5),ref(65,6),ref(65,7)];
        const d=selectD(history,"session",80);
        const covered=new Set([...d.seeds.map(s=>band(s.importance)),...d.recent.map(r=>band(r.importance!))]);
        for(const r of history.slice(0,4)) if(!covered.has(band(r.importance!))) expect(d.diverse.some(p=>band(p.importance!)===band(r.importance!))).toBe(true);
        expect(new Set(d.references.map(r=>r.id)).size).toBe(7);
        expect(selectD(history,"session",80).references.map(r=>r.id)).toEqual(d.references.map(r=>r.id));
    });
    test("D does not invent low bands when older history is all high",()=>{
        const d=selectD(Array.from({length:10},(_,i)=>ref(74,i)),"session",100);
        expect(d.olderBandCounts).toEqual([0,6,0,0,0]);
        expect(d.diverse.map(r=>r.sequence)).toEqual([3,4,5]);
    });
    test("D excludes empty boundary markers before counting and band selection",()=>{
        const history=Array.from({length:10},(_,i)=>ref(74,i));
        history.splice(2,0,{...ref(1,100),title:"",content:"",p1:"",p2:"",p3:"",p4:""});
        const d=variantD(prompt,history,"session",100);
        expect(d.selected.olderBandCounts).toEqual([0,6,0,0,0]);
        expect(d.selected.references.map(r=>r.sequence)).toEqual([3,4,5,6,7,8,9]);
        expect(d.prompt.match(/<session_references>[\s\S]*?<\/session_references>/)![0].match(/<compartment /g)).toHaveLength(7);
    });
    test("D preserves literal regex replacement syntax in historical prose",()=>{
        const history=Array.from({length:10},(_,i)=>({...ref(74,i),p1:"literal $& and $` and $'"}));
        const d=variantD(prompt,history,"session",100);
        const block=d.prompt.match(/<session_references>[\s\S]*?<\/session_references>/)![0];
        expect(block.match(/<compartment /g)).toHaveLength(7);
        expect(block.match(/literal \$&amp; and \$` and \$'/g)).toHaveLength(7);
    });
});
test("E hides only the recent four scores and keeps D's three diverse scores, seeds and text",()=>{
    const history=Array.from({length:10},(_,i)=>ref(74,i));
    const d=variantD(prompt,history,"session",100).prompt;
    const e=variantE(d);
    const refBlock=e.match(/<session_references>[\s\S]*?<\/session_references>/)![0];
    const tags=[...refBlock.matchAll(/<compartment\b[^>]*>/g)].map(m=>m[0]);
    expect(tags).toHaveLength(7);
    expect(tags.slice(0,3).every(t=>t.includes('importance="74"'))).toBe(true);
    expect(tags.slice(3).every(t=>!t.includes("importance="))).toBe(true);
    expect(e.match(/<compartment_examples_from_other_projects>[\s\S]*?<\/compartment_examples_from_other_projects>/)![0]).toBe(d.match(/<compartment_examples_from_other_projects>[\s\S]*?<\/compartment_examples_from_other_projects>/)![0]);
    expect(e.replace(/\s+importance="\d+"/g, "")).toBe(d.replace(/\s+importance="\d+"/g, ""));
    expect(()=>variantE(prompt)).toThrow("E requires D's seven references");
});
test("literal scoring distribution uses population sd",()=>{
    expect(distribution([10,20])).toEqual({n:2,min:10,max:20,mean:15,sd:5});
});
test("extract scores, titles and p1 from multiple model compartments",()=>{
    expect(scores('<compartment start="1" end="2" title="work" importance="74"><p1>Body</p1></compartment>')).toEqual([{start:1,end:2,title:"work",importance:74,p1:"Body"}]);
    expect(()=>scores('<compartment importance="101"></compartment>')).toThrow("Invalid output score");
});
