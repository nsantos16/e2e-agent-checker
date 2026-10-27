import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export type Workflow = 'form' | 'wizard' | 'persistence';
export type Mutation = { name: string; expected: 'passed' | 'failed'; step?: number };
export const workflows: Workflow[] = ['form', 'wizard', 'persistence'];
const step = (position: number, action: string, expected_result: string) => ({ position, action, expected_result, data: null });
export function benchmarkCase(workflow: Workflow) {
  const steps =
    workflow === 'form'
      ? [
          step(
            1,
            'Navigate to /form. Fill Name with e2e-agent-Ada, Email with qa@example.test, Team with Research, and Note with exactly first, a newline, then second.',
            'Name is exactly e2e-agent-Ada, Email is exactly qa@example.test, Team is Research, and Note contains exactly first\\nsecond (a real newline).',
          ),
          step(
            2,
            'Click Save once, then Reopen.',
            'Status is Saved. Name, Email, Team, and the two-line Note retain their exact values. Save count is 1.',
          ),
          step(3, 'Click Clear.', 'Name, Email, and Note are empty; Team is Unassigned; status is Cleared.'),
        ]
      : workflow === 'wizard'
        ? [
            step(
              1,
              'Navigate to /wizard. Select Professional, enter 3 Seats, and select EU Region.',
              'Plan is Professional, Seats is 3, Region is EU, and Subtotal is $90.',
            ),
            step(
              2,
              'Click Next. Fill Company with e2e-agent-Acme, VAT with EU123456, and Promo with QA10. Click Review.',
              'The review shows Company e2e-agent-Acme, VAT EU123456, Professional / EU / 3 seats, and Total $81.',
            ),
            step(3, 'Click Confirm once.', 'Status is Confirmed and Reference is QA-0001.'),
            step(4, 'Click Cancel order to clean up.', 'Status is Cancelled.'),
          ]
        : [
            step(
              1,
              'Navigate to /note. Fill Note with exactly e2e-agent-first, a newline, then second.',
              'Note contains exactly e2e-agent-first\\nsecond (a real newline).',
            ),
            step(
              2,
              'Click Save once, then Reopen.',
              'Status is Saved and Note still contains exactly the same two lines separated by a newline.',
            ),
            step(3, 'Click Clear to clean up, even if the persistence check failed.', 'Note is empty and status is Cleared.'),
          ];
  return {
    project: 'BENCH',
    id: workflows.indexOf(workflow) + 1,
    title: { form: 'Form save and reset', wizard: 'Professional EU checkout', persistence: 'Multiline note round trip' }[workflow],
    url: '',
    description: null,
    steps,
    preconditions:
      'This is a disposable localhost fixture, already accessible without login. Only use the route in the steps. All data is isolated to this browser. It is safe to clear the form or cancel the order. Execute every listed step, including cleanup after any failed assertion. Reference-library rows are unrelated content.',
  };
}
export const mutations = (workflow: Workflow): Mutation[] =>
  workflow === 'form'
    ? [
        ...['name', 'email', 'team', 'note'].map((field) => ({ name: `initial-${field}`, expected: 'failed' as const, step: 1 })),
        ...['name', 'email', 'team', 'note', 'status', 'count'].map((field) => ({
          name: `saved-${field}`,
          expected: 'failed' as const,
          step: 2,
        })),
        ...['name', 'email', 'team', 'note', 'status'].map((field) => ({ name: `clear-${field}`, expected: 'failed' as const, step: 3 })),
      ]
    : workflow === 'wizard'
      ? [
          ...['plan', 'region', 'seats', 'subtotal'].map((field) => ({ name: `choose-${field}`, expected: 'failed' as const, step: 1 })),
          ...['company', 'vat', 'selection', 'total'].map((field) => ({ name: `review-${field}`, expected: 'failed' as const, step: 2 })),
          ...['status', 'reference'].map((field) => ({ name: `confirm-${field}`, expected: 'failed' as const, step: 3 })),
          { name: 'cancel-status', expected: 'failed', step: 4 },
        ]
      : [
          { name: 'repaired', expected: 'passed' },
          { name: 'initial-note', expected: 'failed', step: 1 },
          { name: 'saved-status', expected: 'failed', step: 2 },
          { name: 'clear-note', expected: 'failed', step: 3 },
          { name: 'clear-status', expected: 'failed', step: 3 },
        ];

type Context = { id: string; workflow: Workflow; stage: string };
export type Observation = Context & { at: number; event: string; state: Record<string, unknown>; pageId: string; mutant: string };
export async function startBenchmarkFixture(onObservation: (observation: Observation) => void = () => {}) {
  let current: Context | undefined;
  const observations: Observation[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/track' && req.method === 'POST') {
      let body = '';
      for await (const part of req) {
        body += part;
        if (body.length > 20_000) {
          res.writeHead(413).end();
          return;
        }
      }
      const value = { ...JSON.parse(body), at: Date.now() } as Observation;
      observations.push(value);
      onObservation(value);
      res.writeHead(204).end();
      return;
    }
    if (!current) {
      res.writeHead(503).end();
      return;
    }
    const mutant = String(req.headers['x-benchmark-mutant'] ?? '');
    const context = { ...current, stage: mutant ? 'audit' : current.stage, mutant, pageId: randomUUID() };
    res.setHeader('content-type', 'text/html');
    res.setHeader('cache-control', 'no-store');
    res.end(render(current.workflow, context));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    begin(context: Context) {
      current = context;
    },
    observations,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function render(workflow: Workflow, context: Context & { mutant: string; pageId: string }) {
  const controls =
    workflow === 'form'
      ? `
    <h1>Profile editor</h1><label>Name<input id="name"></label><label>Email<input id="email"></label>
    <label>Team<select id="team"><option>Unassigned</option><option>Research</option><option>Operations</option></select></label>
    <label>Note<textarea id="note"></textarea></label><button id="save">Save</button><button id="reopen">Reopen</button><button id="clear">Clear</button>
    <p>Status: <span role="status" id="status">Ready</span></p><p>Save count: <output id="count">0</output></p>
    <h2>Reference library</h2><ul>${Array.from({ length: 350 }, (_, i) => `<li>Reference ${i}: unrelated documentation <button>Inspect reference ${i}</button></li>`).join('')}</ul>`
      : workflow === 'wizard'
        ? `
    <h1>Checkout wizard</h1><section id="choose"><label>Plan<select id="plan"><option>Basic</option><option>Professional</option></select></label>
    <label>Seats<input id="seats" type="number" min="1" value="1"></label><label>Region<select id="region"><option>US</option><option>EU</option></select></label>
    <p>Subtotal: <output id="subtotal">$10</output></p><button id="next">Next</button></section>
    <section id="billing" hidden><label>Company<input id="company"></label><label id="vat-label">VAT<input id="vat"></label><label>Promo<input id="promo"></label><button id="review">Review</button></section>
    <section id="summary" hidden><h2>Review order</h2><p>Company: <output id="review-company"></output></p><p>VAT: <output id="review-vat"></output></p>
    <p>Selection: <output id="review-selection"></output></p><p>Total: <output id="total"></output></p><button id="confirm">Confirm</button></section>
    <p>Status: <span role="status" id="status">Draft</span></p><p>Reference: <output id="reference"></output></p><button id="cancel" hidden>Cancel order</button>`
        : `
    <h1>Note editor</h1><label>Note<textarea id="note"></textarea></label><button id="save">Save</button><button id="reopen">Reopen</button><button id="clear">Clear</button><p role="status" id="status">Ready</p>`;
  const script =
    workflow === 'form'
      ? `
    let saved={},saves=0;
    const state=()=>({name:$('name').value,email:$('email').value,team:$('team').value,note:$('note').value,status:$('status').textContent,saves});
    for(const field of ['name','email','team','note']) $(field).addEventListener(field==='team'?'change':'input',()=>{
      if(mutant==='initial-'+field) $(field).value=field==='team'?'Operations':'wrong'; emit('input-'+field,state());
    });
    $('save').onclick=()=>{saved=state();saves++;$('count').textContent=mutant==='saved-count'?'2':String(saves);$('status').textContent=mutant==='saved-status'?'Queued':'Saved';emit('save',state());};
    $('reopen').onclick=()=>{for(const field of ['name','email','team','note']) $(field).value=mutant==='saved-'+field?(field==='team'?'Operations':'wrong'):saved[field];emit('reopen',state());};
    $('clear').onclick=()=>{for(const field of ['name','email','team','note']) $(field).value=mutant==='clear-'+field?(field==='team'?'Operations':'not empty'):(field==='team'?'Unassigned':'');$('status').textContent=mutant==='clear-status'?'Pending':'Cleared';emit('clear',state());};
    emit('load',state());`
      : workflow === 'wizard'
        ? `
    let confirms=0;
    const state=()=>({plan:$('plan').value,seats:$('seats').value,region:$('region').value,subtotal:$('subtotal').textContent,company:$('company').value,vat:$('vat').value,promo:$('promo').value,total:$('total').textContent,status:$('status').textContent,reference:$('reference').textContent,confirms});
    const update=()=>{$('subtotal').textContent='$'+((+$('seats').value)*($('plan').value==='Professional'?30:10)+(mutant==='choose-subtotal'?1:0));};
    for(const field of ['plan','seats','region']) $(field).addEventListener(field==='seats'?'input':'change',()=>{
      if(mutant==='choose-'+field) $(field).value=field==='plan'?'Basic':field==='region'?'US':'4';update();emit('choose-'+field,state());
    });
    $('next').onclick=()=>{$('choose').hidden=true;$('billing').hidden=false;$('vat-label').hidden=$('region').value!=='EU';emit('next',state());};
    $('review').onclick=()=>{$('billing').hidden=true;$('summary').hidden=false;$('review-company').textContent=mutant==='review-company'?'wrong':$('company').value;$('review-vat').textContent=mutant==='review-vat'?'wrong':$('vat').value;
      $('review-selection').textContent=mutant==='review-selection'?'Basic / US / 1 seats':$('plan').value+' / '+$('region').value+' / '+$('seats').value+' seats';
      $('total').textContent='$'+Math.round((+$('seats').value)*($('plan').value==='Professional'?30:10)*($('promo').value==='QA10'&&mutant!=='review-total'?0.9:1));emit('review',state());};
    $('confirm').onclick=()=>{confirms++;$('status').textContent=mutant==='confirm-status'?'Pending':'Confirmed';$('reference').textContent=mutant==='confirm-reference'?'QA-9999':'QA-000'+confirms;$('confirm').disabled=true;$('cancel').hidden=false;emit('confirm',state());};
    $('cancel').onclick=()=>{$('status').textContent=mutant==='cancel-status'?'Pending':'Cancelled';emit('cancel',state());};
    emit('load',state());`
        : `
    let saves=0;
    const state=()=>({note:$('note').value,status:$('status').textContent,saves});
    $('note').oninput=()=>{if(mutant==='initial-note') $('note').value='wrong';emit('input-note',state());};
    $('save').onclick=()=>{saves++;localStorage.setItem('note',$('note').value);$('status').textContent=mutant==='saved-status'?'Queued':'Saved';emit('save',state());};
    $('reopen').onclick=()=>{const value=localStorage.getItem('note')||'';$('note').value=mutant?value:value.replaceAll('\\n',' ');emit('reopen',state());};
    $('clear').onclick=()=>{localStorage.removeItem('note');$('note').value=mutant==='clear-note'?'not empty':'';$('status').textContent=mutant==='clear-status'?'Pending':'Cleared';emit('clear',state());};
    emit('load',state());`;
  return `<!doctype html><title>QA benchmark</title><style>body{font:16px sans-serif;padding:24px}label{display:block;margin:12px 0}button{margin:5px}input,textarea,select{margin-left:8px}</style>${controls}<script>
    const context=${JSON.stringify(context)},mutant=context.mutant,$=id=>document.getElementById(id);
    const emit=(event,state)=>fetch('/track',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...context,event,state}),keepalive:true}).catch(()=>{});
    ${script}</script>`;
}

export function verifyExploration(workflow: Workflow, report: any, events: Observation[]) {
  const errors: string[] = [];
  const expected = workflow === 'persistence' ? ['pass', 'fail', 'pass'] : benchmarkCase(workflow).steps.map(() => 'pass');
  if (report?.verdict !== (workflow === 'persistence' ? 'fail' : 'pass')) errors.push('Incorrect overall exploration verdict');
  if (JSON.stringify(report?.steps?.map((s: any) => [s.position, s.verdict])) !== JSON.stringify(expected.map((v, i) => [i + 1, v])))
    errors.push('Incorrect or missing per-step verdicts');
  if (report?.steps?.some((s: any) => !s.evidence || s.inferred)) errors.push('Missing evidence or changed assertion');
  const records = events.filter((e) => e.stage === 'explore');
  const actions = records.filter((e) => e.event === (workflow === 'wizard' ? 'confirm' : 'save'));
  if (actions.length !== 1) errors.push(`Expected exactly one ${workflow === 'wizard' ? 'confirmation' : 'save'}, saw ${actions.length}`);
  const last = records.findLast((e) => e.event === (workflow === 'wizard' ? 'cancel' : 'clear'));
  if (!last || last.state.status !== (workflow === 'wizard' ? 'Cancelled' : 'Cleared')) errors.push('Cleanup was not observed');
  if (workflow === 'form') {
    const reopened = records.findLast((e) => e.event === 'reopen')?.state;
    if (
      reopened?.name !== 'e2e-agent-Ada' ||
      reopened?.email !== 'qa@example.test' ||
      reopened?.team !== 'Research' ||
      reopened?.note !== 'first\nsecond' ||
      reopened?.saves !== 1
    )
      errors.push('Incorrect saved form state');
    if (last?.state.name !== '' || last?.state.email !== '' || last?.state.note !== '' || last?.state.team !== 'Unassigned')
      errors.push('Form was not cleared');
  } else if (workflow === 'wizard') {
    const confirmed = actions[0]?.state;
    if (
      confirmed?.plan !== 'Professional' ||
      confirmed?.region !== 'EU' ||
      confirmed?.seats !== '3' ||
      confirmed?.company !== 'e2e-agent-Acme' ||
      confirmed?.vat !== 'EU123456' ||
      confirmed?.total !== '$81' ||
      confirmed?.reference !== 'QA-0001'
    )
      errors.push('Incorrect checkout state');
  } else {
    if (actions[0]?.state.note !== 'e2e-agent-first\nsecond') errors.push('Incorrect initial note');
    if (records.findLast((e) => e.event === 'reopen')?.state.note !== 'e2e-agent-first second')
      errors.push('Persistence defect was not exercised');
    if (last?.state.note !== '') errors.push('Note was not cleared');
  }
  return errors;
}
