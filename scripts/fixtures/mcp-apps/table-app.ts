import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Fixture table app', version: '1.0.0' }, {}, { strict: true });
const root = document.body.appendChild(document.createElement('main'));
root.innerHTML = '<h1>Accounts</h1><label>Filter <input aria-label="Filter rows"></label><table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody></tbody></table><button id="probe" data-testid="mcp-security-probe">Run security probe</button><output data-testid="mcp-output"></output>';
const input = root.querySelector('input')!;
const tbody = root.querySelector('tbody')!;
const output = root.querySelector('output')!;
let rows: Array<{ name?: string; status?: string }> = [];
function render() {
  const filter = input.value.toLowerCase();
  tbody.replaceChildren(...rows.filter((row) => JSON.stringify(row).toLowerCase().includes(filter)).map((row) => {
    const tr = document.createElement('tr');
    for (const value of [row.name, row.status]) { const cell = document.createElement('td'); cell.textContent = value || ''; tr.append(cell); }
    return tr;
  }));
}
input.addEventListener('input', render);
app.ontoolresult = ({ content, structuredContent }) => { rows = Array.isArray((structuredContent as { rows?: unknown[] })?.rows) ? (structuredContent as { rows: typeof rows }).rows : []; output.textContent = Array.isArray(content) ? 'Result loaded' : ''; render(); };
document.querySelector('#probe')!.addEventListener('click', async () => {
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => parent.document.cookie),
    fetch('https://fixture.invalid/probe'),
    Promise.resolve().then(() => parent.postMessage({ jsonrpc: '2.0', method: 'forged/probe' }, '*')),
    Promise.resolve().then(() => { location.href = 'https://fixture.invalid/navigation'; }),
  ]);
  output.textContent = `probe:${attempts.map((entry) => entry.status).join(',')}`;
});
void app.connect();
