const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('homepage reaches the recording studio and each service inquiry without checkout', () => {
  const { document } = parseHTML(fs.readFileSync('index.html', 'utf8'));
  const recording = [...document.querySelectorAll('a')].find(link => link.textContent.trim() === 'Open Recording Studio');
  assert.equal(recording.getAttribute('href'), 'studio.html');
  const cards = [...document.querySelectorAll('#artist-services .card')];
  assert.deepEqual(cards.map(card => card.getAttribute('href')), [
    'artist-services.html?service=vocals#serviceForm',
    'artist-services.html?service=songwriting#serviceForm',
    'artist-services.html?service=promotion#serviceForm'
  ]);
  assert.match(document.querySelector('#artist-services').textContent, /automated checkout remains paused/);
});

for (const [key, service] of [
  ['vocals', 'Custom Vocals & Hooks'],
  ['songwriting', 'Songwriting'],
  ['promotion', 'Artist Promotion']
]) {
  test(`the ${key} card opens the matching service and prepares an accurate email`, () => {
    const html = fs.readFileSync('artist-services.html', 'utf8');
    const { window, document } = parseHTML(html);
    window.location = { search: `?service=${key}`, href: '' };
    // linkedom omits the native select.value setter. Supply the browser's
    // writable value property while running the real inquiry-page script.
    const select = document.getElementById('service');
    Object.defineProperty(select, 'value', {
      value: select.querySelector('option').textContent,
      writable: true, configurable: true
    });
    const context = vm.createContext({ window, document, URLSearchParams });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
    vm.runInContext(script, context);
    assert.equal(document.getElementById('service').value, service);
    document.getElementById('customerName').value = 'A prospective artist';
    document.getElementById('customerEmail').value = 'artist@example.com';
    document.getElementById('details').value = 'Hook & verse\nBudget: $100';
    document.getElementById('serviceForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
    const email = new URL(window.location.href);
    assert.equal(email.protocol, 'mailto:');
    assert.equal(email.pathname, 'streetsoul8316@gmail.com');
    assert.equal(email.searchParams.get('subject'), `StarRise Artist Services Inquiry - ${service}`);
    assert.match(email.searchParams.get('body'), /artist@example.com/);
    assert.ok(email.searchParams.get('body').includes('Hook & verse\nBudget: $100'));
  });
}
