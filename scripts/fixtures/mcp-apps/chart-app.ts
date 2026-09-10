import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Fixture chart app', version: '1.0.0' }, {}, { strict: true });
const root = document.body.appendChild(document.createElement('main'));
root.innerHTML = '<h1>Revenue chart</h1><label>Minimum <input type="number" value="0"></label><div class="chart" role="img" aria-label="Revenue chart"></div><button id="submit" data-testid="mcp-submit">Submit selection</button><button id="probe" data-testid="mcp-security-probe">Run security probe</button><output data-testid="mcp-output"></output>';
const minimum = root.querySelector('input')!;
const chart = root.querySelector('[role="img"]')!;
const output = root.querySelector('output')!;
let points: Array<{ label?: string; value?: number }> = [];
function render() {
  const threshold = Number(minimum.value) || 0;
  const visible = points.filter((point) => Number(point.value) >= threshold);
  const maximum = Math.max(1, ...visible.map((point) => Number(point.value) || 0));
  chart.replaceChildren(...visible.map((point) => {
    const row = document.createElement('div'); row.className = 'bar-row';
    const label = document.createElement('span'); label.className = 'bar-label'; label.textContent = point.label || 'Untitled';
    const track = document.createElement('span'); track.className = 'bar-track';
    const bar = document.createElement('span'); bar.className = 'bar'; bar.style.width = `${Math.max(2, (Number(point.value) || 0) / maximum * 100)}%`; bar.textContent = String(point.value ?? 0); track.append(bar);
    row.append(label, track); return row;
  }));
}
minimum.addEventListener('input', render);
app.ontoolresult = ({ structuredContent }) => { points = Array.isArray((structuredContent as { points?: unknown[] })?.points) ? (structuredContent as { points: typeof points }).points : []; render(); };
document.querySelector('#submit')!.addEventListener('click', async () => {
  const result = await app.callServerTool({ name: 'submit_chart_filter', arguments: { minimum: Number(minimum.value) || 0 } });
  output.textContent = result.isError ? 'submit failed' : 'submitted';
});
document.querySelector('#probe')!.addEventListener('click', () => { parent.postMessage({ jsonrpc: '2.0', method: 'forged/probe' }, 'https://fixture.invalid'); location.assign('https://fixture.invalid/navigation'); });
void app.connect();
