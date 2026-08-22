#!/usr/bin/env node
import noble from '@stoprocent/noble';

const SCAN_DURATION_MS = 15000;
const seen = new Map();

async function main() {
  if (noble.state !== 'poweredOn') {
    console.log('Waiting for Bluetooth to power on...');
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('BT not powered on')), 5000);
      noble.once('stateChange', (s) => {
        if (s === 'poweredOn') { clearTimeout(t); resolve(); }
      });
    });
  }

  noble.on('discover', (p) => {
    const name = p.advertisement.localName || '';
    const id = p.id;
    const mfgData = p.advertisement.manufacturerData;
    const serviceUuids = p.advertisement.serviceUuids || [];
    const prev = seen.get(id);
    const entry = {
      name,
      address: p.address,
      rssi: p.rssi,
      serviceUuids,
      mfg: mfgData ? mfgData.toString('hex') : null,
    };
    seen.set(id, entry);

    const looksLikeMoko =
      /mk107|moko/i.test(name) ||
      (mfgData && mfgData.length >= 2 && mfgData.readUInt16LE(0) === 0x015c);

    if (looksLikeMoko && !prev) {
      console.log(`>>> POSSIBLE MOKOSMART MK107: ${name || '(no name)'} [${id}] RSSI ${p.rssi}`);
      console.log(`    serviceUuids: ${serviceUuids.join(', ') || '(none)'}`);
      console.log(`    mfgData: ${entry.mfg}`);
    }
  });

  await noble.startScanningAsync([], true);
  console.log(`Scanning for ${SCAN_DURATION_MS / 1000}s...`);

  setTimeout(async () => {
    try { await noble.stopScanningAsync(); } catch {}
    console.log(`\n=== Found ${seen.size} unique devices ===`);
    const rows = [...seen.entries()].map(([id, e]) => ({ id, ...e }));
    rows.sort((a, b) => b.rssi - a.rssi);
    for (const r of rows) {
      const nameStr = r.name || '(no name)';
      const svc = r.serviceUuids.length ? ` svc=[${r.serviceUuids.join(',')}]` : '';
      const mfg = r.mfg ? ` mfg=${r.mfg.slice(0, 24)}${r.mfg.length > 24 ? '...' : ''}` : '';
      console.log(`  RSSI ${String(r.rssi).padStart(4)}  ${r.id}  ${nameStr}${svc}${mfg}`);
    }
    process.exit(0);
  }, SCAN_DURATION_MS);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
