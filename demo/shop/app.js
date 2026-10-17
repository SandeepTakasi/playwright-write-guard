// Tidewell Admin: a small client-side router over the store's JSON API. Every button works
// without a guard: the confirm dialog calls the API, and a failed call shows a toast.
const main = document.getElementById('main');
const toastEl = document.getElementById('toast');
const dialog = document.getElementById('confirm');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd = (cents) => money.format(cents / 100);
const when = (s) => new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (s) => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const initials = (name) => name.split(' ').map((w) => w[0]).join('').slice(0, 2);
const badge = (payment) => `<span class="pill pill-${payment.toLowerCase()}">${esc(payment)}</span>`;
const testBadge = '<span class="pill pill-test">Test order</span>';

let filter = 'all';
const selected = new Set();
let toastTimer;

function toast(text, kind = 'ok') {
  toastEl.textContent = text;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 6000);
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Resolves true when the staff member confirms.
function confirmAction(title, body, action) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent = body;
  document.getElementById('confirm-ok').textContent = action;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

async function write(path, options, done, failed) {
  try {
    await api(path, options);
    toast(done);
    return true;
  } catch (err) {
    toast(`${failed}: ${err instanceof TypeError ? 'the request did not reach the store' : err.message}`, 'error');
    return false;
  }
}

async function refund(order) {
  if (!(await confirmAction(`Refund order ${order.number}?`, `${usd(order.total)} will be returned to ${order.customer}'s original payment method. This cannot be undone.`, `Refund ${usd(order.total)}`))) return;
  await write(`/api/orders/${order.id}/refund`, { method: 'POST' }, `Order ${order.number} refunded`, `Could not refund order ${order.number}`);
  render();
}

async function remove(order) {
  if (!(await confirmAction(`Delete order ${order.number}?`, 'The order, its payment record and its history are permanently removed. This cannot be undone.', 'Delete order'))) return;
  if (await write(`/api/orders/${order.id}`, { method: 'DELETE' }, `Order ${order.number} deleted`, `Could not delete order ${order.number}`)) {
    selected.delete(order.id);
    if (location.pathname !== '/orders') return go('/orders');
  }
  render();
}

async function removeSelected() {
  const ids = [...selected];
  const n = ids.length;
  if (!(await confirmAction(`Delete ${n} order${n === 1 ? '' : 's'}?`, 'The selected orders, their payment records and their history are permanently removed. This cannot be undone.', `Delete ${n} order${n === 1 ? '' : 's'}`))) return;
  const ok = await write('/api/orders/bulk-delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) },
    `${n} order${n === 1 ? '' : 's'} deleted`, `Could not delete ${n} order${n === 1 ? '' : 's'}`);
  if (ok) selected.clear();
  render();
}

function stat(label, value, note = '') {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
}

async function ordersPage() {
  const orders = await api('/api/orders');
  document.getElementById('order-count').textContent = orders.length;
  for (const id of selected) if (!orders.some((o) => o.id === id)) selected.delete(id);
  const shown = orders.filter((o) => filter === 'all' || (filter === 'test' ? o.test : o.payment === filter));
  const tabs = [['all', 'All', orders.length], ['Paid', 'Paid'], ['Pending', 'Pending'], ['Refunded', 'Refunded'], ['test', 'Test orders']]
    .map(([key, label]) => `<button type="button" class="tab${filter === key ? ' active' : ''}" data-filter="${key}" aria-pressed="${filter === key}">${label}<span>${key === 'all' ? orders.length : orders.filter((o) => (key === 'test' ? o.test : o.payment === key)).length}</span></button>`).join('');
  const paid = orders.filter((o) => o.payment === 'Paid');
  main.innerHTML = `
    <div class="page-head"><div><h1>Orders</h1><p class="muted">All orders placed in the staging store, newest first.</p></div></div>
    <div class="stats">
      ${stat('Orders', orders.length, 'since Oct 6')}
      ${stat('Revenue', usd(paid.reduce((s, o) => s + o.total, 0)), `${paid.length} paid orders`)}
      ${stat('Awaiting payment', orders.filter((o) => o.payment === 'Pending').length, 'not charged yet')}
      ${stat('Test orders', orders.filter((o) => o.test).length, 'placed by QA Automation')}
    </div>
    <section class="card">
      <div class="toolbar">
        <div class="tabs">${tabs}</div>
        <div class="bulk${selected.size ? ' on' : ''}">
          <span>${selected.size} selected</span>
          <button type="button" class="btn btn-danger-outline" id="bulk-delete" ${selected.size ? '' : 'disabled'}>Delete selected</button>
        </div>
      </div>
      <table>
        <thead><tr>
          <th class="check"><input type="checkbox" id="select-all" aria-label="Select all orders" ${shown.length && shown.every((o) => selected.has(o.id)) ? 'checked' : ''}></th>
          <th>Order</th><th>Customer</th><th>Date</th><th class="num">Items</th><th class="num">Total</th><th>Payment</th><th class="actions"><span class="sr">Actions</span></th>
        </tr></thead>
        <tbody>${shown.map((o) => `
          <tr data-id="${o.id}" class="${selected.has(o.id) ? 'sel' : ''}">
            <td class="check"><input type="checkbox" data-select="${o.id}" aria-label="Select order ${o.number}" ${selected.has(o.id) ? 'checked' : ''}></td>
            <td><a href="/orders/${o.id}" data-link class="order-link">${o.number}</a>${o.test ? ` ${testBadge}` : ''}</td>
            <td><span class="who"><span class="avatar sm" aria-hidden="true">${esc(initials(o.customer))}</span>${esc(o.customer)}</span></td>
            <td class="muted">${when(o.placed)}</td>
            <td class="num">${o.items}</td>
            <td class="num strong">${usd(o.total)}</td>
            <td>${badge(o.payment)}</td>
            <td class="actions">
              <button type="button" class="btn btn-sm" data-refund="${o.id}" aria-label="Refund order ${o.number}" ${o.payment === 'Paid' ? '' : 'disabled title="Only a paid order can be refunded"'}>Refund</button>
              <button type="button" class="btn btn-sm btn-danger-outline" data-delete="${o.id}" aria-label="Delete order ${o.number}">Delete</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty">No orders match this filter.</td></tr>'}
        </tbody>
      </table>
      <div class="table-foot muted">Showing ${shown.length} of ${orders.length} orders</div>
    </section>`;
  const byId = (id) => orders.find((o) => o.id === Number(id));
  main.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; render(); }));
  main.querySelectorAll('[data-refund]').forEach((b) => b.addEventListener('click', () => refund(byId(b.dataset.refund))));
  main.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => remove(byId(b.dataset.delete))));
  // Selection changes only the view, so it updates the DOM without asking the server again.
  const boxes = [...main.querySelectorAll('[data-select]')];
  const all = main.querySelector('#select-all');
  const sync = () => {
    for (const c of boxes) {
      c.checked = selected.has(Number(c.dataset.select));
      c.closest('tr').classList.toggle('sel', c.checked);
    }
    all.checked = boxes.length > 0 && boxes.every((c) => c.checked);
    main.querySelector('.bulk').classList.toggle('on', selected.size > 0);
    main.querySelector('.bulk span').textContent = `${selected.size} selected`;
    main.querySelector('#bulk-delete').disabled = selected.size === 0;
  };
  boxes.forEach((c) => c.addEventListener('change', () => {
    if (c.checked) selected.add(Number(c.dataset.select)); else selected.delete(Number(c.dataset.select));
    sync();
  }));
  all.addEventListener('change', () => {
    for (const o of shown) if (all.checked) selected.add(o.id); else selected.delete(o.id);
    sync();
  });
  main.querySelector('#bulk-delete').addEventListener('click', removeSelected);
}

async function orderPage(id) {
  const o = await api(`/api/orders/${id}`);
  const c = o.customer;
  main.innerHTML = `
    <a href="/orders" data-link class="back">&larr; Orders</a>
    <div class="page-head">
      <div><h1>Order ${o.number} ${badge(o.payment)} ${o.test ? testBadge : ''}</h1><p class="muted">Placed ${when(o.placed)}</p></div>
      <div class="head-actions">
        <button type="button" class="btn btn-primary" id="refund" ${o.payment === 'Paid' ? '' : 'disabled title="Only a paid order can be refunded"'}>Refund ${usd(o.total)}</button>
      </div>
    </div>
    <div class="detail">
      <section class="card">
        <h2>Items</h2>
        <table class="items">
          <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${usd(i.price)}</td><td class="num">${usd(i.qty * i.price)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="3">Total</td><td class="num">${usd(o.total)}</td></tr></tfoot>
        </table>
      </section>
      <aside>
        <section class="card">
          <h2>Customer</h2>
          <div class="who lg"><span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span><span><strong>${esc(c.name)}</strong><small>${esc(c.email)}</small></span></div>
          <p class="muted">${esc(c.city)}, customer since ${day(c.joined)}</p>
        </section>
        <section class="card">
          <h2>Payment</h2>
          <dl><dt>Status</dt><dd>${badge(o.payment)}</dd><dt>Method</dt><dd>Card ending 4242</dd><dt>Amount</dt><dd>${usd(o.total)}</dd></dl>
        </section>
      </aside>
    </div>`;
  main.querySelector('#refund').addEventListener('click', () => refund({ ...o, customer: c.name }));
}

async function customersPage() {
  const list = await api('/api/customers');
  main.innerHTML = `
    <div class="page-head"><div><h1>Customers</h1><p class="muted">${list.length} customers</p></div></div>
    <section class="card">
      <table>
        <thead><tr><th>Name</th><th>Location</th><th class="num">Orders</th><th class="num">Total spent</th><th>Customer since</th></tr></thead>
        <tbody>${list.map((c) => `
          <tr>
            <td><span class="who lg"><span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span><span><strong>${esc(c.name)}${c.city === 'Staging' ? '<span class="pill pill-test">Test account</span>' : ''}</strong><small>${esc(c.email)}</small></span></span></td>
            <td class="muted">${esc(c.city)}</td>
            <td class="num">${c.orders}</td>
            <td class="num strong">${usd(c.spent)}</td>
            <td class="muted">${day(c.joined)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
}

function go(path) {
  history.pushState(null, '', path);
  return render();
}

async function render() {
  const path = location.pathname === '/' ? '/orders' : location.pathname;
  if (path !== location.pathname) history.replaceState(null, '', path);
  const section = path.startsWith('/customers') ? 'customers' : 'orders';
  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.section === section));
  const detail = path.match(/^\/orders\/(\d+)$/);
  document.title = `${detail ? `Order #${detail[1]}` : section === 'orders' ? 'Orders' : 'Customers'} | Tidewell Admin`;
  try {
    if (detail) await orderPage(detail[1]);
    else if (section === 'customers') await customersPage();
    else await ordersPage();
  } catch (err) {
    main.innerHTML = `<div class="card empty">Could not load this page: ${esc(err.message)}</div>`;
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', render);
render();
