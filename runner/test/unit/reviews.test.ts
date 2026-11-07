import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { stills, withCharset } from '../../src/review-media.ts';

function fixture() {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Compare these', accountId: 'claude-3' });
  h.adapter.last.init();
  const source = path.join(h.home, 'mockup.png');
  fs.writeFileSync(source, makePng(120, 80));
  const input = { title: 'Account picker', options: [
    { id: 'A', title: 'First', path: source },
    { id: 'B', title: 'Second', path: source },
    { id: 'D', title: 'Reference', path: source, reference: true },
  ] };
  return { h, thread, source, input };
}

test('review imports files, persists draft and stays needsYou after read and restart', () => {
  const {h, thread, source, input} = fixture();
  const {review} = h.runner.createReview(thread.id, input);
  assert.equal(h.runner.get(thread.id).needsYou, false, 'no Needs you while the turn that showed it is still running');
  assert.equal(review.options.length, 3);
  assert.notEqual(review.options[0].image.path, source);
  fs.unlinkSync(source);
  assert.ok(fs.existsSync(review.options[0].image.path));
  const saved = h.runner.saveReview(thread.id, review.id, review.revision, {pickedId:'B', notes:{D:'Keep this behaviour'}}).review;
  h.adapter.last.result();
  h.runner.markSeen(thread.id, h.runner.get(thread.id).lastSeq);
  assert.equal(h.runner.get(thread.id).needsYou, true);
  assert.equal(h.runner.get(thread.id).pendingReviews, 1);
  const again = h.restart();
  assert.deepEqual(again.runner.getReview(thread.id, review.id).review.draft, saved.draft);
  assert.equal(again.runner.get(thread.id).needsYou, true);
});

test('review validation leaves no partial card or copied assets', () => {
  const {h,thread,input}=fixture();
  const count=h.runner.events(thread.id).events.length;
  for(const options of [[], [...input.options,{...input.options[0]}], [{...input.options[0], path:'/does/not/exist'}], [{...input.options[0], title:''}], [{...input.options[0], reference:'yes'}]]) {
    assert.throws(()=>h.runner.createReview(thread.id,{...input,options} as any));
  }
  assert.equal(h.runner.events(thread.id).events.length,count);
  assert.equal(h.runner.get(thread.id).pendingReviews,undefined);
});

test('review rejects stale writes, unknown IDs and reference picks, supports notes-only and cancel', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const saved=h.runner.saveReview(thread.id,review.id,0,{notes:{A:'More room'}}).review;
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,0,{notes:{}}),/changed|revision/i);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,saved.revision,{pickedId:'D',notes:{}}),/reference/i);
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,saved.revision,{notes:{wrong:'oops'}}),/option/i);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,saved.revision,{notes:{}}),/pick|note/i);
  const result=h.runner.respondReview(thread.id,review.id,saved.revision,{notes:{D:'Useful with either'}});
  assert.equal(result.review.status,'answered');
  assert.equal(result.review.response?.pickedId,undefined);
  const r2=h.runner.createReview(thread.id,input).review;
  assert.equal(h.runner.cancelReview(thread.id,r2.id,r2.revision).review.status,'cancelled');
  assert.throws(()=>h.runner.saveReview(thread.id,r2.id,1,{notes:{}}),/cancelled/i);
});

test('response queues after busy turn, includes metadata and duplicate retries never send twice', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const draft={pickedId:'B',notes:{A:'Too much chrome',D:'Looks good'}};
  const result=h.runner.respondReview(thread.id,review.id,review.revision,draft);
  assert.equal(h.adapter.last.sent.length,1);
  assert.equal(h.store.load(thread.id)?.queue.length,1);
  assert.deepEqual(h.runner.respondReview(thread.id,review.id,review.revision,draft),result);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,1,{pickedId:'A',notes:{}}),/answered/i);
  h.adapter.last.result(); await tick();
  assert.equal(h.adapter.last.sent.length,2);
  const messages=h.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message');
  assert.equal(messages.length,2);
  const reply=messages[1];
  assert.equal(reply.reviewId,review.id);
  assert.deepEqual(reply.reviewResponse,draft);
  assert.match(reply.text,/Account picker/);
  assert.match(reply.text,/Picked B/);
  assert.match(reply.text,/Notes on D/);
  assert.equal(h.runner.get(thread.id).pendingReviews,undefined);
});

test('accepted review reply survives restart before a busy turn finishes', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const draft={pickedId:'A',notes:{}};
  const sent=h.runner.respondReview(thread.id,review.id,review.revision,draft);
  const again=h.restart(); await tick();
  assert.deepEqual(again.runner.respondReview(thread.id,review.id,0,draft),sent);
  assert.equal(again.adapter.last.sent.length,1);
  assert.match(again.adapter.last.sent[0].text,/Picked A/);
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message'&&e.reviewId===review.id).length,1);
});

test('show_options uses the calling thread and returns a review ID without waiting', async () => {
  const {h,thread,input}=fixture();
  const tool=buildThreadbearTools(h.runner,thread.id).find(t=>t.name==='show_options');
  assert.ok(tool);
  const result=await tool.handler(input as any,{} as any);
  assert.equal(result.isError,undefined);
  assert.match(JSON.stringify(result),/review|choice|later/i);
  assert.equal(h.runner.get(thread.id).pendingReviews,1);
});

test('failed atomic save keeps a review pending, and an accepted outbox repairs a missing card after restart', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const save=h.store.save.bind(h.store);
  h.store.save=()=>{throw new Error('disk full')};
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}}),/disk full/);
  h.store.save=save;
  assert.equal(h.runner.getReview(thread.id,review.id).review.status,'pending');
  assert.equal(h.store.load(thread.id)?.queue.length,0);
  const log=h.store.log(thread.id);
  const append=log.append.bind(log);
  log.append=()=>{throw new Error('event append failed')};
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}}),/append failed/);
  log.append=append;
  assert.equal(h.store.load(thread.id)?.reviews?.[0].status,'answered');
  const again=h.restart();await tick();
  assert.equal(again.runner.getReview(thread.id,review.id).review.status,'answered');
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='review.updated'&&e.review.status==='answered').length,1);
  assert.equal(again.adapter.last.sent.length,1);
});

test('a stale outbox saved before user.message was appended does not replay an already delivered answer', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}});
  const queue=structuredClone(h.store.load(thread.id)!.queue);
  h.adapter.last.result();await tick();
  const rec=h.store.load(thread.id)!;
  rec.queue=queue;h.store.save(rec);
  const again=h.restart();await tick();
  assert.equal(again.adapter.sessions.length,0);
  assert.equal(again.store.load(thread.id)!.queue.length,0);
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message'&&e.reviewId===review.id).length,1);
});

test('review RPC methods validate, save, answer and reopen through the authenticated server', async () => {
  const {RpcServer}=await import('../../src/rpc.ts');
  const {RunnerClient}=await import('../../src/client.ts');
  const {nullLogger}=await import('../../src/log.ts');
  const {h,thread,input}=fixture();
  const server=new RpcServer({host:'127.0.0.1',port:0,token:'test-review-token',runner:h.runner,log:nullLogger});
  const {port}=await server.listen();
  const client=await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`,'test-review-token');
  try {
    await assert.rejects(client.call('reviews.create',{threadId:thread.id,title:'bad',options:[]}), (e:any)=>e.code===-32602);
    const {review}=await client.call('reviews.create',{threadId:thread.id,...input});
    assert.equal((await client.call('reviews.list',{threadId:thread.id})).reviews[0].id,review.id);
    for (const method of ['reviews.get','reviews.list','reviews.cancel']) {
      await assert.rejects(client.call(method,{threadId:42,reviewId:42,revision:0}),(e:any)=>e.code===-32602);
    }
    const saved=await client.call('reviews.save',{threadId:thread.id,reviewId:review.id,revision:review.revision,draft:{pickedId:'B',notes:{A:'Too much'}}});
    assert.equal(saved.review.revision,1);
    await assert.rejects(client.call('reviews.save',{threadId:thread.id,reviewId:review.id,revision:0,draft:{notes:{}}}),(e:any)=>e.code===-32602);
    const answered=await client.call('reviews.respond',{threadId:thread.id,reviewId:review.id,revision:1,draft:saved.review.draft});
    assert.equal(answered.review.status,'answered');
    assert.deepEqual((await client.call('reviews.list',{threadId:thread.id})).reviews,[]);
    const reopened=await client.call('reviews.get',{threadId:thread.id,reviewId:review.id});
    assert.deepEqual(reopened.review.response,saved.review.draft);
    const another=(await client.call('reviews.create',{threadId:thread.id,...input})).review;
    assert.equal((await client.call('reviews.cancel',{threadId:thread.id,reviewId:another.id,revision:0})).review.status,'cancelled');
  } finally {client.close();await server.close();}
});

test('an answered review reconstructs its outbox if queue removal was saved before dispatch', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'B',notes:{}});
  const rec=h.store.load(thread.id)!;
  rec.queue=[];h.store.save(rec);
  const again=h.restart();await tick();
  assert.match(again.adapter.last.sent[0].text,/Picked B/);
});

test('show_options is shared with Codex dynamic tools and routes to the runner owning the thread', async () => {
  const {dynamicToolSpecs}=await import('../../src/adapters/codex/tools.ts');
  const {ThreadRouter}=await import('../../src/handover.ts');
  const {h,thread,input}=fixture();
  const tools=buildThreadbearTools(h.runner,thread.id,Date.now,undefined,undefined,undefined,{provider:'codex'});
  const specs=dynamicToolSpecs(tools);
  assert.match(JSON.stringify(specs),/show_options/);
  const calls:{method:string;params:unknown}[]=[];
  const router=new ThreadRouter(h.runner,()=>({
    owns:(id:string)=>id==='remote-thread',
    call:async(method:string,params:unknown)=>{calls.push({method,params});return {review:{id:'remote-review'}}},
  } as any));
  const reply=await router.createReview('remote-thread',input);
  assert.equal(reply.review.id,'remote-review');
  assert.deepEqual(calls,[{method:'reviews.create',params:{threadId:'remote-thread',...input}}]);
  assert.equal((await router.createReview(thread.id,input)).review.title,input.title);
});

test('review reply survives a failed turn.started append after its user.message was saved', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  const log=h.store.log(thread.id);
  const append=log.append.bind(log);
  log.append=(event)=>{if(event.type==='turn.started') throw new Error('disk full');append(event)};
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'B',notes:{}});
  assert.equal(h.adapter.last.sent.length,1,'no second message reached the CLI');
  log.append=append;
  const again=h.restart();await tick();
  assert.equal(again.adapter.last.sent.length,1);
  assert.match(again.adapter.last.sent[0].text,/Picked B/);
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message'&&e.reviewId===review.id).length,1);
  assert.deepEqual(again.store.load(thread.id)?.reviewDeliveries,[review.id]);
});

test('special option IDs do not invent notes from Object.prototype', () => {
  const {h,thread,input}=fixture();
  input.options[0].id='__proto__';input.options[1].id='constructor';
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'constructor',notes:{}});
  const queued=h.store.load(thread.id)!.queue[0];
  assert.match(queued.text,/Picked constructor/);
  assert.doesNotMatch(queued.text,/Notes on|Object|native code/);
});


test('pending reviews list stays oldest-first after draft changes', () => {
  const {h,thread,input}=fixture();
  const first=h.runner.createReview(thread.id,input).review;
  h.clock.advance(1);
  const second=h.runner.createReview(thread.id,input).review;
  h.runner.saveReview(thread.id,first.id,0,{pickedId:'A',notes:{}});
  assert.deepEqual(h.runner.listReviews(thread.id).reviews.map(r=>r.id),[first.id,second.id]);
});

test('a reply whose session.send fails is recovered after restart', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  h.adapter.last.send=()=>{throw new Error('CLI unavailable')};
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}});
  await tick();
  assert.equal(h.store.load(thread.id)?.reviewDeliveries,undefined);
  const again=h.restart();await tick();
  assert.match(again.adapter.last.sent[0].text,/Picked A/);
  assert.deepEqual(again.store.load(thread.id)?.reviewDeliveries,[review.id]);
});

test('a message from Mike supersedes open reviews; runner, schedule and agent messages do not', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  h.runner.send(thread.id,'reminder',[],{origin:'schedule'});
  h.runner.send(thread.id,'carry on',[],{origin:'runner'});
  h.runner.send(thread.id,'[Sent by the agent in the thread "Other" (abcd1234)]\n\nhello');
  assert.equal(h.runner.getReview(thread.id,review.id).review.status,'pending');
  assert.equal(h.runner.get(thread.id).pendingReviews,1);
  h.runner.send(thread.id,'Actually, build a mock app first');
  const after=h.runner.getReview(thread.id,review.id).review;
  assert.equal(after.status,'superseded');
  assert.equal(after.revision,review.revision+1);
  assert.equal(h.runner.get(thread.id).pendingReviews,undefined);
  assert.deepEqual(h.runner.listReviews(thread.id).reviews,[]);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,after.revision,{pickedId:'A',notes:{}}),/superseded/);
  const last=h.runner.events(thread.id).events.filter(e=>e.type==='review.updated').at(-1);
  assert.equal(last?.type==='review.updated'&&last.review.status,'superseded');
});

test('a message from the phone supersedes open reviews too', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  h.runner.send(thread.id,'from my phone',[],{origin:'phone'});
  assert.equal(h.runner.getReview(thread.id,review.id).review.status,'superseded');
});

// An option's several shots used to be options of their own (A2, A3) that
// couldn't be picked; and Mike often wants two of them, or none, in his own
// words (4 Nov).
test('an option keeps its shots and url, and old single-image options are unchanged', () => {
  const {h,thread,source}=fixture();
  const {review}=h.runner.createReview(thread.id,{title:'Diagrams',options:[
    {id:'A',title:'Board',path:source,url:'http://localhost:5190/a',shots:[{path:source,title:'Mid-drag'},{path:source,title:'Detail'}]},
    {id:'B',title:'Dossier',shots:[{path:source,title:'Overview'},{path:source}]},
    {id:'C',title:'Map',path:source},
  ]});
  const [a,b,c]=review.options;
  assert.equal(a.shots?.length,3);
  assert.equal(a.shots?.[0].image.path,a.image.path,'image is the first shot, for clients that show one');
  assert.deepEqual(a.shots?.map(s=>s.title),[undefined,'Mid-drag','Detail']);
  assert.equal(a.url,'http://localhost:5190/a');
  assert.equal(new Set(a.shots?.map(s=>s.image.path)).size,3,'each shot is its own copy');
  assert.deepEqual(b.shots?.map(s=>s.title),['Overview',undefined]);
  assert.equal(c.shots,undefined);
  assert.equal(c.url,undefined);
  for (const bad of [
    {id:'X',title:'No picture'},
    {id:'X',title:'Bad url',path:source,url:'javascript:alert(1)'},
    {id:'X',title:'Too many',shots:Array.from({length:9},()=>({path:source}))},
    {id:'X',title:'Missing',path:source,shots:[{path:'/does/not/exist'}]},
  ]) assert.throws(()=>h.runner.createReview(thread.id,{title:'Bad',options:[bad as any]}),/./,JSON.stringify(bad));
  assert.throws(()=>h.runner.createReview(thread.id,{title:'Too big',options:Array.from({length:6},(_,i)=>({id:`O${i}`,title:'Many',shots:Array.from({length:7},()=>({path:source}))}))}),/at most 40/);
});

test('recommended marks the agent\'s pick, and must name an option that can be picked', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,{...input,recommended:'B'});
  assert.equal(review.recommended,'B');
  assert.equal(h.restart().runner.getReview(thread.id,review.id).review.recommended,'B');
  assert.equal(h.runner.createReview(thread.id,input).review.recommended,undefined);
  assert.throws(()=>h.runner.createReview(thread.id,{...input,recommended:'Z'}),/option ids/);
  assert.throws(()=>h.runner.createReview(thread.id,{...input,recommended:'D'}),/reference/);
});

test('several picks, none, and a reply go to the agent in the order of the options', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const saved=h.runner.saveReview(thread.id,review.id,0,{pickedIds:['B','A'],notes:{},reply:'  The board, with the sandbox for the video. '}).review;
  assert.deepEqual(saved.draft,{pickedId:'A',pickedIds:['A','B'],notes:{},reply:'The board, with the sandbox for the video.'});
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,saved.revision,{pickedIds:['A'],none:true,notes:{}}),/none/i);
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,saved.revision,{pickedIds:['A','D'],notes:{}}),/reference/i);
  // An older client's pickedId alone still works.
  const old=h.runner.saveReview(thread.id,review.id,saved.revision,{pickedId:'B',notes:{}}).review;
  assert.deepEqual(old.draft,{pickedId:'B',notes:{}});
  const answered=h.runner.respondReview(thread.id,review.id,old.revision,{pickedIds:['A','B'],notes:{D:'Keep this'},reply:'Both, please.'});
  const sent=h.store.load(thread.id)!.queue.at(-1)!;
  assert.equal(sent.text,`Review: Account picker (${review.id})\n\nPicked A + B. First + Second.\n\nBoth, please.\n\nNotes on D (Reference): Keep this`);
  // Retrying the same answer is the same answer, whichever order it came in.
  assert.equal(h.runner.respondReview(thread.id,review.id,old.revision,{pickedIds:['B','A'],notes:{D:'Keep this'},reply:'Both, please.'}).turnId,answered.turnId);
});

test('none of them, with or without a reply, is an answer', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{none:true,notes:{}});
  const sent=h.store.load(thread.id)!.queue.at(-1)!;
  assert.equal(sent.text,`Review: Account picker (${review.id})\n\nPicked none of them.`);
  const second=h.runner.createReview(thread.id,input).review;
  h.runner.respondReview(thread.id,second.id,0,{notes:{},reply:'Can you explain what these are for?'});
  const reply=h.store.load(thread.id)!.queue.at(-1)!;
  assert.equal(reply.text,`Review: Account picker (${second.id})\n\nCan you explain what these are for?`);
});

// The smallest file sniffVideo calls an MP4: an ftyp box, nothing to play.
function fakeMp4(): Buffer {
  const box = Buffer.alloc(16);
  box.writeUInt32BE(16, 0);
  box.write('ftypisom', 4, 'ascii');
  return box;
}

test('a shot can be a video or an HTML page: copied with a still, and the page brings what it names', (t) => {
  // Nothing here can draw the fake clip, and Quick Look hangs on it till its timeout.
  t.mock.method(stills,'quickLook',()=>undefined);
  t.mock.method(stills,'ffmpegFrame',()=>undefined);
  const {h,thread,source}=fixture();
  const clip=path.join(h.home,'clip.mp4');
  fs.writeFileSync(clip,fakeMp4());
  const site=path.join(h.home,'site');
  fs.mkdirSync(path.join(site,'img'),{recursive:true});
  fs.writeFileSync(path.join(site,'img','a.png'),makePng(4,4));
  fs.writeFileSync(path.join(site,'style.css'),'body{background:url("img/bg.png")}');
  fs.writeFileSync(path.join(site,'img','bg.png'),makePng(2,2));
  fs.writeFileSync(path.join(h.home,'secret.txt'),'not for the page');
  fs.writeFileSync(path.join(site,'other.html'),'<p>another page</p>');
  fs.symlinkSync(path.join(h.home,'secret.txt'),path.join(site,'linked.png'));
  const page=path.join(site,'index.html');
  fs.writeFileSync(page,'<link rel="stylesheet" href="style.css"><img src="img/a.png?v=2"><img src="../secret.txt"><img src="linked.png"><img src="https://example.com/x.png"><a href="other.html">next</a>');
  const {review}=h.runner.createReview(thread.id,{title:'Clips',options:[
    {id:'A',title:'Clip',path:clip},
    {id:'B',title:'Page',path:source,shots:[{path:page,title:'Live'}]},
  ]});
  const [a,b]=review.options;
  assert.equal(a.shots?.length,1,'a lone video still comes as a shot, so its media isn’t lost');
  assert.equal(a.shots?.[0].media?.mediaType,'video/mp4');
  assert.notEqual(a.shots?.[0].media?.path,clip);
  assert.deepEqual(fs.readFileSync(a.shots![0].media!.path),fakeMp4());
  assert.equal(a.image.path,a.shots?.[0].image.path,'the option’s image is the video’s still');
  assert.ok(fs.existsSync(a.image.path)&&a.image.width&&a.image.height,'a still even when nothing can draw this clip');
  assert.equal(b.shots?.[0].media,undefined,'a picture has no media');
  const copied=b.shots![1].media!;
  assert.equal(copied.mediaType,'text/html');
  assert.equal(path.basename(copied.path),'index.html');
  const folder=path.dirname(copied.path);
  for (const f of ['style.css','img/a.png','img/bg.png']) assert.ok(fs.existsSync(path.join(folder,f)),f);
  assert.ok(!fs.existsSync(path.join(folder,'..','secret.txt')),'nothing from outside the page’s folder');
  assert.ok(!fs.existsSync(path.join(folder,'other.html')),'other pages aren’t followed');
  assert.ok(!fs.existsSync(path.join(folder,'linked.png')),'nor a link out of the folder');
  assert.ok(fs.existsSync(b.shots![1].image.path));
  const notes=path.join(h.home,'notes.txt');
  fs.writeFileSync(notes,'plain text');
  assert.throws(()=>h.runner.createReview(thread.id,{title:'Bad',options:[{id:'X',title:'Text',path:notes}]}),/video \(MP4, MOV\) or HTML page/);
});

// Mike, 7 Nov: a mockup with ✓ and no charset showed "âœ“" in the review
// window and its still, both of which read an undeclared page as Latin-1.
test('a review page that is UTF-8 without saying so gets a charset in its copy', () => {
  const page=(s:string|Buffer)=>withCharset(Buffer.isBuffer(s)?s:Buffer.from(s,'utf8')).toString('latin1');
  assert.equal(page('<p>✓ done</p>'),Buffer.from('<meta charset="utf-8"><p>✓ done</p>','utf8').toString('latin1'));
  assert.match(page('<!DOCTYPE html><html><p>✓</p>'),/^<!DOCTYPE html><meta charset="utf-8"><html>/,'after the doctype, so no quirks mode');
  for (const s of ['<head><meta charset="windows-1252"></head>✓','<meta http-equiv="Content-Type" content="text/html; charset=utf-8">✓','﻿<p>✓</p>'])
    assert.equal(page(s),Buffer.from(s,'utf8').toString('latin1'),'its own declaration or BOM stands');
  const latin1=Buffer.from([0x3c,0x70,0x3e,0xe9,0x3c,0x2f,0x70,0x3e]); // <p>é</p> in Latin-1, not valid UTF-8
  assert.deepEqual(withCharset(latin1),latin1,'a page in another encoding is left alone');
});
