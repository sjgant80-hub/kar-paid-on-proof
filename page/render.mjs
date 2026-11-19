// page/render.mjs — every number, table and verdict on the live page, as pure functions that return strings.
// Used twice, so the two can never disagree: tools/build-page.mjs bakes their output into index.html (the page is
// complete before any script runs, and to any reader that does not run scripts), and the page's own script calls
// the same functions, inlined byte for byte, when a visitor changes an input. Presentation only: no rule lives
// here (the rules are the gated kernels it calls), so it is tested (test/render.test.mjs), not mutation-gated.
import { verifyDeliverable } from '../sdk/verify.mjs';
import { checkSessionAction, screenInjection, KIND_CALL, KIND_TRANSFER } from '../sdk/policy.mjs';
import { staffTime, NLW_SOURCE } from '../sdk/cost.mjs';

export const DEPLOY_ORDER = ['AgentIdentityRegistry', 'ValidationRegistry', 'Fallmarket', 'FulfilmentGate', 'AgentAccount'];
export const STEP_TITLES = { S0: 'Deploy', S1: 'ERC-8004 identities', S2: 'Fund and scope the key', S3: 'Fallmarket listing', S4: 'Take the job', S5: 'The injection', S6: 'The work', S7: 'The verdict', S8: 'Release on proof', S9: 'An ungrounded deliverable', S10: 'Metabolism', S11: 'Revoke' };
export const TUSD8_ADDRESS = '0x456569838f1d43009A91ebA4263147Afd7233483';
export const ATTACKER_ADDRESS = '0xBAD000000000000000000000000000000000BaD0';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function short(h) {
  return h ? h.slice(0, 10) + '…' + h.slice(-6) : '';
}
export function fmt2(n) {
  return Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function int(n) {
  return Number(n).toLocaleString('en-GB');
}

function txLink(explorer, hash) {
  if (!hash) return '';
  return explorer ? `<a class="mono" href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener">${short(hash)}</a>` : `<span class="mono" title="${esc(hash)}">${short(hash)}</span>`;
}
function addrLink(explorer, a) {
  return explorer ? `<a class="mono" href="${esc(explorer)}/address/${esc(a)}" target="_blank" rel="noopener">${esc(a)}</a>` : `<span class="mono">${esc(a)}</span>`;
}
function describeEvents(s) {
  if (s.error) return `refused on-chain: <b>${esc(s.error.name)}</b>${s.error.args && s.error.args.length ? ' (' + esc(s.error.args.map(String).join(', ')) + ')' : ''}`;
  const names = (s.events || []).map((e) => e.name).filter(Boolean);
  return names.length ? 'events: ' + esc([...new Set(names)].join(', ')) : '';
}

// ── the recorded run ─────────────────────────────────────────────────────────
// trail: runs/aevum.json when it exists, else runs/local.json. ctx.dryrun: receipts/aevum-dryrun.json.
// ctx.verify: receipts/aevum-verify.json (each Aevum hash checked against the chain's own receipt), if any.
export function runView(trail, ctx = {}) {
  const dry = ctx.dryrun || null;
  const ver = ctx.verify || null;
  const onAevum = trail.network === 'aevum';
  const ex = onAevum ? trail.explorer : null;
  const exA = (dry && 'https://explorer-test.qday.info') || null;
  const refused = trail.steps.filter((s) => s.status === 'reverted');
  const passed = trail.checks.filter((c) => c.ok).length;
  const gas = trail.steps.reduce((a, s) => a + Number(s.gasUsed || 0), 0);
  const deploySteps = trail.steps.filter((s) => s.step === 'S0' && /^deploy /.test(s.label) && s.label !== 'deploy MockUSD8');
  const deployGas = deploySteps.reduce((a, s) => a + Number(s.gasUsed || 0), 0);
  const b = trail.final.balances;
  const v = {};

  // the hero: the testnet proof, or plainly the lack of it
  const find = (pred) => trail.steps.find(pred);
  const key = onAevum ? [
    ['Paid on proof', find((s) => s.step === 'S8' && s.status === 'success')],
    ['Injection refused', find((s) => s.step === 'S5' && s.error?.name === 'RecipientNotAllowed')],
    ['Injection refused again (over the cap)', find((s) => s.step === 'S5' && s.error?.name === 'OverCap')],
    ['Release without a PASS refused', find((s) => s.step === 'S9' && s.status === 'reverted')],
    ['Refund on FAIL', find((s) => s.step === 'S9' && s.status === 'success' && /refund/i.test(s.label))],
    ['Revoked key refused', find((s) => s.step === 'S11' && s.status === 'reverted')],
  ].filter(([, s]) => s) : [];
  v.heroProof = onAevum
    ? `<div class="card state ok"><div class="statehead"><span class="pill ok">on QDay Aevum testnet</span> <b>${trail.steps.length} real transactions on chain 44005, ${esc(trail.started.slice(0, 10))}</b></div>`
      + `<table class="keytx">${key.map(([t, s]) => `<tr><td>${esc(t)}</td><td>${txLink(ex, s.hash)}${s.error ? ` <span class="pill bad">${esc(s.error.name)}</span>` : ' <span class="pill ok">ok</span>'}</td><td class="meta">block ${esc(s.block)}</td></tr>`).join('')}</table>`
      + `<p class="meta">FulfilmentGate ${addrLink(ex, trail.contracts.FulfilmentGate)} · AgentAccount ${addrLink(ex, trail.contracts.AgentAccount)}. Every transaction, every balance change and every contract is below, each linked to explorer-test.qday.info.${ver ? ` ${ver.matched}/${ver.total} hashes re-read from Aevum's own receipts after the run.` : ''}</p></div>`
    : `<div class="card state pending"><div class="statehead"><span class="pill warn">pending</span> <b>The testnet proof: not recorded yet</b></div>`
      + `<p>This entry is judged on real transactions on QDay Aevum testnet (chain 44005). There are none yet: the deployer address${dry && dry.deployer ? ` ${addrLink(exA, dry.deployer)}` : ''} is waiting for test gas. When it has it, one command (<code>node tools/aevum-go.mjs</code>) runs the whole flow on Aevum, and this box fills with the transaction hashes, each linked to the explorer.</p>`
      + `<p class="meta">Until then, every run on this page is labelled <b>SIMULATED</b>: the same compiled contracts on a local EVM, not the testnet.</p></div>`;
  v.runTitle = onAevum ? 'The run, on QDay Aevum testnet' : 'The run <span class="pill warn">SIMULATED · local EVM, not the testnet</span>';

  v.badges = [
    `<span class="badge"><span class="dot ${onAevum ? 'ok' : 'warn'}"></span>${onAevum ? 'QDay Aevum testnet · chain 44005' : 'SIMULATED local run · the testnet run is pending'}</span>`,
    `<span class="badge"><span class="dot ok"></span>${trail.steps.length} transactions</span>`,
    `<span class="badge"><span class="dot bad"></span>${refused.length} refused on-chain, as designed</span>`,
    `<span class="badge"><span class="dot ${passed === trail.checks.length ? 'ok' : 'bad'}"></span>${passed}/${trail.checks.length} checks</span>`,
    `<span class="badge"><span class="dot ${b.attacker === '0.00' ? 'ok' : 'bad'}"></span>attacker received ${esc(b.attacker)}</span>`,
  ].join('');

  v.runsub = onAevum
    ? `The recorded run on QDay Aevum testnet, ${esc(trail.started.slice(0, 16).replace('T', ' '))} UTC, from commit <code>${esc((trail.commit || '').slice(0, 7))}</code>. Click any hash to open it on the explorer.`
    : `Below is the recorded <b>local</b> run: the same contracts and the same flow on an in-process Shanghai EVM, with a mock tUSD8, from commit <code>${esc((trail.commit || '').slice(0, 7))}</code>. Every hash is a real transaction on that chain; none of them is on Aevum. You can reproduce it in your browser, below.`;

  // the Aevum panel: honest about what exists on Aevum today
  if (onAevum) {
    const vline = ver ? `${ver.matched}/${ver.total} hashes checked against Aevum's own receipts after the run (status and block match)` : 'hashes not yet re-checked against the chain';
    const pred = ver && ver.predicted ? ` The five contract addresses were predicted before the run from the deployer's nonce; ${ver.predicted.matched}/${ver.predicted.total} matched.` : '';
    v.aevum = `<div class="card state ok"><div class="statehead"><span class="pill ok">recorded</span> <b>On QDay Aevum testnet</b></div>`
      + `<p>${trail.steps.length} transactions, ${refused.length} refused on-chain as designed, ${passed}/${trail.checks.length} checks; ${esc(vline)}.${esc(pred)}</p>`
      + `<p class="meta">Deploy gas, measured on Aevum: <b>${int(deployGas)}</b>${dry ? ` (the read-only simulation at block ${esc(dry.block)} said ${int(dry.deployGas)})` : ''}. Deployer ${addrLink(trail.explorer, trail.roles.principal)}.</p></div>`;
  } else {
    v.aevum = `<div class="card state pending"><div class="statehead"><span class="pill warn">pending</span> <b>On QDay Aevum testnet: the run is not recorded yet</b></div>`
      + `<p>Nothing in the run below is an Aevum transaction yet. The same flow runs on Aevum once the deployer address below holds test gas. It writes <code>runs/aevum.json</code>; the page rebuilds from it, every hash becomes an explorer link, and claim P12 is filled from the chain's own receipts. Nobody edits anything by hand.</p>`
      + (dry
        ? `<p class="meta">Already done on Aevum, read-only (nothing sent): Aevum's own EVM simulated each deployment at block ${esc(dry.block)}. Every runtime size matches the artifact, and the identity registry matches byte for byte. Deploy gas, simulated: <b>${int(dry.deployGas)}</b> = ${esc(Number(dry.deployCostTQDAY).toFixed(4))} tQDAY at ${esc(Number(dry.gasPriceWei) / 1e9)} gwei. The measured figure replaces it after the run.${dry.deployer ? ` Deployer: ${addrLink(exA, dry.deployer)} (nonce ${esc(dry.deployerNonce)} at that block).` : ''}</p>`
        : '')
      + `</div>`;
  }

  v.kpis = [
    ['Escrowed and released', b.worker + ' tUSD8', 'to the worker, after PASS + re-check'],
    ['Refunded on FAIL', '1.00 tUSD8', 'the reworded answer was never paid'],
    ['Injected payment', '10,000 tUSD8 asked', 'paid: ' + b.attacker],
    ['Gas for the whole run', int(gas), 'units, ' + trail.steps.length + ' transactions'],
  ].map(([t, val, s]) => `<div class="card"><div class="meta">${esc(t)}</div><div class="kpi">${esc(val)}<small>${esc(s)}</small></div></div>`).join('');

  let last = '';
  v.timeline = trail.steps.map((s) => {
    const head = s.step !== last ? `<div class="meta" style="font-weight:700;color:var(--ink)">${esc(STEP_TITLES[s.step] || s.step)}</div>` : '';
    last = s.step;
    const pill = s.status === 'success' ? '<span class="pill ok">ok</span>' : '<span class="pill bad">refused</span>';
    const ev = describeEvents(s);
    return `<li class="${s.status === 'success' ? '' : 'refused'}"><div class="st">${esc(s.step)}</div><div class="what">${head}<b>${esc(s.label)}</b> ${pill}<div class="meta">${esc(s.actor)} · ${txLink(ex, s.hash)} · block ${esc(s.block)} · gas ${esc(s.gasUsed)}${ev ? ' · ' + ev : ''}</div></div></li>`;
  }).join('');

  v.final = `<tr><th>Who</th><th class="num">tUSD8</th></tr>`
    + `<tr><td>Worker (paid for the grounded answer)</td><td class="num">${esc(b.worker)}</td></tr>`
    + `<tr><td>Agent account (refunded for the reworded one)</td><td class="num">${esc(b.agentAccount)}</td></tr>`
    + `<tr><td>FulfilmentGate (nothing stranded)</td><td class="num">${esc(b.gate)}</td></tr>`
    + `<tr><td>0xBAD… (the injection's address)</td><td class="num">${esc(b.attacker)}</td></tr>`
    + `<tr><td>Session key: spent of cap</td><td class="num">${esc(trail.final.session.spent)} / ${esc(trail.final.session.cap)} · ${trail.final.session.active ? 'active' : 'revoked'}</td></tr>`
    + `<tr><td>Worker's verified record</td><td class="num">${esc(trail.final.workerValidations.count)} verdicts, average ${esc(trail.final.workerValidations.average)}/100</td></tr>`
    + `<tr><td>Listing</td><td class="num">${trail.final.listingLive ? 'live' : 'pruned by the market'}</td></tr>`;

  v.checks = trail.checks.map((c) => `<li>${c.ok ? '✓' : '✗'} ${esc(c.name)}</li>`).join('');

  // state changes: each party's tUSD8 read from the chain right after the named transaction, at its block
  const blk = (n) => (ex ? `<a class="mono" href="${esc(ex)}/block/${esc(n)}" target="_blank" rel="noopener">${esc(n)}</a>` : esc(n));
  v.states = (trail.states && trail.states.length)
    ? `<tr><th>Right after</th><th class="num">Block</th><th class="num">Principal</th><th class="num">Agent account</th><th class="num">Gate (escrow)</th><th class="num">Worker</th><th class="num">0xBAD…</th></tr>`
      + trail.states.map((st) => `<tr><td>${esc(st.after)} <span class="meta">(${esc(st.step)}, ${txLink(ex, st.hash)})</span></td><td class="num">${blk(st.block)}</td>${['principal', 'agentAccount', 'gate', 'worker', 'attacker'].map((k) => `<td class="num">${esc(st.balances[k])}</td>`).join('')}</tr>`).join('')
    : `<tr><td>This recorded run predates the balance snapshots; the next run records them.</td></tr>`;

  // gas per step: measured; in tQDAY at the price Aevum charged (Aevum run), or at the dry run's price (local)
  const priceWei = dry ? Number(dry.gasPriceWei) : null;
  const byStep = [];
  for (const s of trail.steps) {
    let row = byStep.find((r) => r.step === s.step);
    if (!row) byStep.push((row = { step: s.step, n: 0, gas: 0, wei: 0, priced: true }));
    row.n++;
    row.gas += Number(s.gasUsed || 0);
    if (s.gasPrice) row.wei += Number(s.gasUsed || 0) * Number(s.gasPrice);
    else row.priced = false;
  }
  const tq = (r) => (onAevum && r.priced ? (r.wei / 1e18).toFixed(6) : priceWei ? ((r.gas * priceWei) / 1e18).toFixed(6) : '');
  const totalGas = byStep.reduce((a, r) => a + r.gas, 0);
  const allPriced = byStep.every((r) => r.priced);
  const totalTq = onAevum && allPriced ? byStep.reduce((a, r) => a + r.wei, 0) / 1e18 : priceWei ? (totalGas * priceWei) / 1e18 : 0;
  v.gasSteps = `<tr><th>Step</th><th>What</th><th class="num">Transactions</th><th class="num">Gas</th><th class="num">tQDAY${onAevum ? ' (as charged)' : priceWei ? ` (at ${esc(priceWei / 1e9)} gwei)` : ''}</th></tr>`
    + byStep.map((r) => `<tr><td>${esc(r.step)}</td><td>${esc(STEP_TITLES[r.step] || r.step)}</td><td class="num">${r.n}</td><td class="num">${int(r.gas)}</td><td class="num">${tq(r)}</td></tr>`).join('')
    + `<tr><td></td><td><b>The whole run</b></td><td class="num"><b>${trail.steps.length}</b></td><td class="num"><b>${int(totalGas)}</b></td><td class="num"><b>${totalTq ? totalTq.toFixed(6) : ''}</b></td></tr>`;
  v.gasNote = onAevum
    ? 'Measured on QDay Aevum testnet: gas used and the price Aevum charged, from each transaction\'s receipt.'
    : `<span class="pill warn">SIMULATED</span> Gas measured on the local EVM running the same bytecode${priceWei ? `, priced at Aevum's gas price at the dry run (block ${esc(dry.block)})` : ''}. The testnet run replaces these with Aevum's own receipts.`;

  // the comparison, with per-unit numbers from the run and the calculator's defaults
  const cost = ctx.cost || null;
  const job1Gas = trail.steps.filter((s) => s.step === 'S4' || s.step === 'S6' || s.step === 'S7' || s.step === 'S8').reduce((a, s) => a + Number(s.gasUsed || 0), 0);
  const injGas = trail.steps.filter((s) => s.step === 'S5').reduce((a, s) => a + Number(s.gasUsed || 0), 0);
  const refundStep = find((s) => s.step === 'S9' && s.status === 'success' && /refund/i.test(s.label));
  const perCheck = cost ? (Number(cost.minutes) / 60) * Number(cost.rate) : null;
  const src = onAevum ? 'the Aevum run' : 'the SIMULATED run';
  v.compare = `<tr><th></th><th>Today: agents with a card or an API key</th><th>With the trust layer (numbers from ${src})</th></tr>`
    + `<tr><td>Who checks the work</td><td>a person, when they have time, or nobody${perCheck != null ? `: ${esc(cost.minutes)} minutes a deliverable = £${fmt2(perCheck)} at £${fmt2(cost.rate)} an hour (the calculator's defaults)` : ''}</td><td>the verifier on every job, and the chain re-checks the quote: ${int(job1Gas)} gas for one paid job end to end (take, submit, request, verdict, release); no person in the loop</td></tr>`
    + `<tr><td>A prompt injection says "pay X"</td><td>the agent's key can pay X, up to everything it holds</td><td>refused on-chain: 0.00 paid of 10,000 asked; ${refused.filter((s) => s.step === 'S5').length} reverted transactions (${int(injGas)} gas)</td></tr>`
    + `<tr><td>Ungrounded work</td><td>paid, then disputed</td><td>never released; the FAIL refunds ${esc(b.agentAccount === '1.00' ? '1.00' : 'the')} tUSD8 in one transaction${refundStep ? ` (${int(refundStep.gasUsed)} gas)` : ''}</td></tr>`
    + `<tr><td>Audit</td><td>logs you keep yourself</td><td>${trail.steps.length} public transactions for the whole run, each re-checkable by anyone</td></tr>`
    + `<tr><td>Licence</td><td>per seat or per transaction</td><td>MIT: no licence fee; you run the contracts</td></tr>`;

  // the contracts: size and simulated Aevum gas from the dry run, this run's address, and (until the Aevum
  // run exists) where each will land on Aevum, predicted from the deployer's nonce and labelled as such
  const rowOf = (n) => (dry ? dry.rows.find((r) => r.contract === n) : null) || {};
  const predicted = !onAevum && dry && dry.predicted;
  v.contracts = `<tr><th>Contract</th><th class="num">Runtime bytes</th><th class="num">Deploy gas on Aevum${onAevum ? ', measured' : ', simulated'}</th><th>${onAevum ? 'Address on Aevum' : 'Address in the local run'}</th>${predicted ? '<th>Address on Aevum (predicted, not deployed yet)</th>' : ''}</tr>`
    + DEPLOY_ORDER.map((n) => {
      const r = rowOf(n);
      const st = deploySteps.find((s) => s.label === 'deploy ' + n);
      const g = onAevum ? (st ? int(st.gasUsed) : '') : (r.gas ? int(r.gas) : '');
      return `<tr><td>${esc(n)}</td><td class="num">${r.runtimeBytes ? int(r.runtimeBytes) : ''}</td><td class="num">${g}</td><td>${trail.contracts[n] ? addrLink(ex, trail.contracts[n]) : ''}</td>${predicted ? `<td><span class="mono">${esc(dry.predicted[n] || '')}</span></td>` : ''}</tr>`;
    }).join('')
    + (onAevum
      ? `<tr><td>tUSD8 (QDay's test dollar)</td><td></td><td></td><td>${addrLink(ex, trail.contracts.tUSD8 || TUSD8_ADDRESS)}</td></tr>`
      : `<tr><td>MockUSD8 (local stand-in for tUSD8)</td><td></td><td></td><td>${addrLink(null, trail.contracts.MockUSD8 || '')}</td>${predicted ? `<td>uses tUSD8 ${addrLink(exA, TUSD8_ADDRESS)}</td>` : ''}</tr>`)
    + `<tr><td>Agents</td><td colspan="${predicted ? 4 : 3}">buyer #${esc(trail.ids.buyerAgentId)}, worker #${esc(trail.ids.workerAgentId)}, DocDec verifier #${esc(trail.ids.validatorAgentId)}; listing #${esc(trail.ids.listingId)}; jobs #${esc(trail.ids.job1)} (paid), #${esc(trail.ids.job2)} (refunded)</td></tr>`;

  // the diagram, traced from the run
  const rel = trail.steps.find((s) => s.step === 'S8');
  v['d-buyer'] = esc(trail.ids.buyerAgentId);
  v['d-worker'] = esc(trail.ids.workerAgentId);
  v['d-val'] = esc(trail.ids.validatorAgentId);
  v['d-cap'] = esc(trail.final.session.cap);
  v['d-paid'] = esc(b.worker);
  v['d-att'] = esc(b.attacker);
  v['d-reltx'] = rel ? 'tx ' + esc(short(rel.hash)) : '';

  v.cgas = `${int(gas)} gas units for all ${trail.steps.length} transactions of the ${onAevum ? 'Aevum' : 'local'} run (both jobs, both attacks, deploys included)`
    + (onAevum ? '' : (dry ? `. On Aevum, the five deployments were simulated at ${int(dry.deployGas)} gas (${Number(dry.deployCostTQDAY).toFixed(4)} tQDAY); the measured figure replaces this after the testnet run` : ''));
  const exv = onAevum && ver && ver.explorer ? ver.explorer : null;
  v.explorerNote = exv
    ? (exv.results.some((r) => r.ok)
      ? `Source verified on explorer-test.qday.info for ${exv.results.filter((r) => r.ok).map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.contract)}</a>`).join(', ')}${exv.results.some((r) => !r.ok) ? `; not for ${exv.results.filter((r) => !r.ok).map((r) => esc(r.contract)).join(', ')} (${esc(exv.results.find((r) => !r.ok).detail)})` : ''}. The exact bytecode is also in <code>artifacts/</code> for anyone to recompile and compare.`
      : `The explorer's contract verifier was tried after the run and did not verify the source (${esc(exv.results[0] ? exv.results[0].detail : 'no result')}), so the exact bytecode is published in <code>artifacts/</code> for anyone to recompile and compare against <code>eth_getCode</code>.`)
    : 'QDay\'s starter kit reports the explorer\'s contract verifier as not working. The testnet run tries it anyway, and this sentence then says what happened. Either way, the exact bytecode is published in <code>artifacts/</code> for anyone to recompile and compare against <code>eth_getCode</code>.';
  v.boardTail = onAevum
    ? 'it is running on QDay Aevum testnet: every step of the run above is a transaction you can open on the explorer.'
    : 'it runs end to end on a Shanghai EVM and in your browser, built for QDay Aevum testnet; the Aevum run is recorded here when it is made.';
  v.critDemo = onAevum
    ? '<a href="#run">The run</a>: every transaction linked to explorer-test.qday.info'
    : '<b>Pending:</b> the testnet run is not recorded yet; when it is, <a href="#run">the run</a> lists every transaction linked to explorer-test.qday.info, with the balance changes. Until then the run shown is SIMULATED (local EVM), and <a href="#browser">the in-browser run</a> is an offline fallback, also SIMULATED';
  return v;
}

// ── the verifier playground ──────────────────────────────────────────────────
export function sourcesView(sources, claims) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return sources.map((s, i) => {
    const bytes = enc.encode(s.text);
    const mine = (claims || []).filter((c) => c && c.doc === i && Number.isInteger(c.start) && Number.isInteger(c.end) && c.start < c.end && c.end <= bytes.length).sort((a, b) => a.start - b.start);
    let html = '';
    let at = 0;
    for (const c of mine) {
      if (c.start < at) continue;
      html += esc(dec.decode(bytes.subarray(at, c.start))) + '<mark>' + esc(dec.decode(bytes.subarray(c.start, c.end))) + '</mark>';
      at = c.end;
    }
    html += esc(dec.decode(bytes.subarray(at)));
    return `<div class="meta" style="margin-top:8px">source ${i}: ${esc(s.title)} · ${bytes.length} bytes</div><div class="src">${html}</div>`;
  }).join('');
}
export function verifyView(question, sources, answer, claimsText) {
  let claims;
  try { claims = JSON.parse(claimsText || '[]'); } catch { claims = 'unreadable'; }
  const r = verifyDeliverable({ question, sources: sources.map((s) => s.text), deliverable: { answer, claims } });
  return {
    cls: r.verdict,
    text: `${r.verdict} · ${r.response}/100 · ${r.reason}`,
    why: r.rebuilt !== undefined ? 'The cited bytes actually say: <code>' + esc(r.rebuilt) + '</code>' : (r.coverage !== undefined ? 'Question coverage: ' + Math.round(r.coverage * 100) + '%' : ''),
    srcs: sourcesView(sources, Array.isArray(claims) ? claims : []),
  };
}
export function claimsText(claims) {
  return JSON.stringify(claims.map((c) => ({ doc: c.doc, start: c.start, end: c.end })));
}

// ── the wall playground ──────────────────────────────────────────────────────
const WHY = { RecipientNotAllowed: 'that address is not on the key\'s allowlist', OverCap: 'it would take the key past its 2.00 tUSD8 cap', SessionNotActive: 'the owner revoked this key', TokenCallForbidden: 'a session may never call the token contract directly (that would bypass the allowlist), even if someone allowlisted it', Malformed: 'the input is not a number' };
export function wallView({ to, amount, spent, revoked }, gate) {
  const GATE = gate || '0x0000000000000000000000000000000000000001';
  const u = (x) => BigInt(Math.round(Number(x || 0) * 1e6));
  const target = { gate: GATE, bad: ATTACKER_ADDRESS, token: TUSD8_ADDRESS }[to];
  const kind = to === 'bad' ? KIND_TRANSFER : KIND_CALL;
  const session = { cap: u(2), spent: u(spent), expiry: 2n ** 40n, active: !revoked, allowlist: to === 'token' ? [GATE, TUSD8_ADDRESS] : [GATE] };
  const r = checkSessionAction(session, { kind, target, amount: u(amount), dataLength: kind === KIND_CALL ? 164 : 0, deadline: 2n ** 40n, signerOk: true, token: TUSD8_ADDRESS }, 1);
  return { cls: r.ok ? 'PASS' : 'FAIL', text: r.ok ? 'The chain would execute this.' : `Refused on-chain: ${r.error}, because ${WHY[r.error] || r.error}.` };
}

// ── the immune screen ────────────────────────────────────────────────────────
export function screenView(text) {
  const r = screenInjection(text);
  return { cls: r.flagged ? 'FAIL' : 'PASS', text: r.flagged ? 'Flagged: ' + r.reasons.join('; ') + (r.addresses.length ? ' · addresses: ' + r.addresses.join(', ') : '') : 'Nothing flagged.' };
}

// ── the cost calculator ──────────────────────────────────────────────────────
export function costView({ jobs, minutes, rate }) {
  const r = staffTime({ jobsPerMonth: jobs, minutesPerCheck: minutes, hourlyRate: rate === '' ? undefined : rate });
  const src = 'Floor rate source: ' + NLW_SOURCE + '.';
  if (!r) return { kpi: '—', text: 'Enter non-negative numbers.', src };
  return { kpi: '£' + fmt2(r.perYear), text: `${fmt2(r.hoursPerMonth)} hours a month of checking deliverables against sources, at £${fmt2(r.rate)} an hour: £${fmt2(r.perMonth)} a month.`, src };
}
