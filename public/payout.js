// The affiliate payout form. Served with /affiliate/payout, which is its own
// document, so this file carries only what that page needs.
(function () {
  const $ = (id) => document.getElementById(id);
  const form = $('poForm');
  const copy = $('poCopy');
  if (copy) copy.addEventListener('click', async () => {
    const text = ($('poLink') || {}).textContent || '';
    try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
    catch (e) { copy.textContent = 'Select and copy'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
  });
  if (!form) return;

  const err = $('poErr');
  const showErr = (m) => { err.textContent = m || ''; err.classList.toggle('hidden', !m); if (m) err.scrollIntoView({ block: 'nearest' }); };
  const method = () => (form.querySelector('input[name="method"]:checked') || {}).value || 'bank';
  const syncMethod = () => {
    const bank = method() === 'bank';
    $('poBank').classList.toggle('hidden', !bank);
    $('poPaypal').classList.toggle('hidden', bank);
    showErr('');
  };
  form.querySelectorAll('input[name="method"]').forEach(r => r.addEventListener('change', syncMethod));
  syncMethod();

  // Digits only in the number fields, whatever gets pasted in.
  ['routing', 'account', 'account2'].forEach(n => {
    const el = form.elements[n];
    el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, ''); });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = { token: form.dataset.token || '', holder: f.holder.value.trim(), method: method() };
    if (body.holder.length < 2) return showErr('Enter the name on the account.');
    if (body.method === 'bank') {
      body.bankName = f.bankName.value.trim();
      body.routing = f.routing.value;
      body.account = f.account.value;
      body.accountType = f.accountType.value;
      if (body.bankName.length < 2) return showErr('Enter the name of your bank.');
      if (body.routing.length !== 9) return showErr('The routing number is 9 digits.');
      if (body.account.length < 4) return showErr('Enter the account number.');
      if (body.account !== f.account2.value) return showErr('The two account numbers do not match.');
    } else {
      body.paypal = f.paypal.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.paypal)) return showErr('Enter the email address on your PayPal account.');
    }
    const btn = $('poSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    showErr('');
    let r;
    try {
      r = await (await fetch('/api/affiliate/payout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    } catch (e2) { r = { error: 'Could not reach the server. Try again in a moment.' }; }
    if (r.error) { showErr(r.error); btn.disabled = false; btn.textContent = 'Save payout details'; return; }
    $('poDoneP').textContent = r.method === 'paypal'
      ? `Payments will go to PayPal at ${r.last4}. You can change this any time from Settings.`
      : `Payments will go to the account ending ${r.last4}. You can change this any time from Settings.`;
    form.classList.add('hidden');
    $('poDone').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
