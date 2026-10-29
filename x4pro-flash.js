// X4 Pro installer: writes CrossInk into the spare OTA app slot and switches
// the boot selector to it, the same way Inky installs official CrossInk. The
// bootloader, the partition table and the firmware currently running are
// never written, so the device keeps whatever layout it shipped with.

var ESPTOOL_URL = "https://cdn.jsdelivr.net/npm/esptool-js@0.5.7/bundle.js";
var SECTOR = 4096;
var OTADATA_BYTES = 2 * SECTOR;     // two boot-selector entries, one per sector
var FLASH_BYTES = 16 * 1024 * 1024; // X4 Pro flash size
var PARTITION_TABLE = 0x8000;
var OTA_STATE_NEW = 0;               // what Inky and esp_ota_set_boot_partition write
var OTA_STATE_INVALID = 3;
var OTA_STATE_ABORTED = 4;
var ESP32_S3_CHIP_ID = 9;

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function le32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }

// ESP-IDF's boot selector CRC: esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4).
function otaSeqCrc(seq) {
  var bytes = le32(seq), crc = 0;
  for (var i = 0; i < 4; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Checks a firmware file's ESP image header: magic byte and ESP32-S3 chip id.
function checkS3Image(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0xE9) throw new Error("This isn't an ESP32 firmware image.");
  var chip = bytes[12] | (bytes[13] << 8);
  if (chip !== ESP32_S3_CHIP_ID) throw new Error("This firmware isn't for the X4 Pro's ESP32-S3.");
}

// Reads the partition table into {otadata, app0, app1}, refusing anything
// that doesn't look like a dual-OTA layout inside the flash.
function parseLayout(table) {
  var otadata = null, app0 = null, app1 = null;
  for (var o = 0; o + 32 <= table.length; o += 32) {
    if (table[o] === 0xFF && table[o + 1] === 0xFF) break;   // end of table
    if (table[o] === 0xEB && table[o + 1] === 0xEB) continue; // MD5 entry
    if (table[o] !== 0xAA || table[o + 1] !== 0x50) throw new Error("The partition table couldn't be read.");
    var type = table[o + 2], subtype = table[o + 3];
    var part = { offset: u32(table, o + 4), size: u32(table, o + 8) };
    if (type === 1 && subtype === 0) otadata = part;
    else if (type === 0 && subtype === 0x10) app0 = part;
    else if (type === 0 && subtype === 0x11) app1 = part;
  }
  if (!otadata) throw new Error("The partition table has no boot selector (otadata).");
  if (!app0 || !app1) throw new Error("The partition table doesn't have two firmware slots.");
  if (otadata.size < OTADATA_BYTES) throw new Error("The boot selector partition is too small.");
  [otadata, app0, app1].forEach(function (p) {
    var end = p.offset + p.size;
    if (p.offset < 0x9000 || end > FLASH_BYTES || end < p.offset) throw new Error("A partition is outside the flash.");
  });
  return { otadata: otadata, apps: [app0, app1] };
}

function readEntry(data, sector) {
  var o = sector * SECTOR, seq = u32(data, o), state = u32(data, o + 24);
  var valid = seq !== 0xFFFFFFFF && u32(data, o + 28) === otaSeqCrc(seq) &&
    state !== OTA_STATE_INVALID && state !== OTA_STATE_ABORTED;
  return { seq: seq, valid: valid };
}

// Works out which slot is booting now and the entry that switches to the
// other one: the highest valid sequence number wins, and it selects app
// (seq - 1) % 2. The new entry replaces the older of the two.
function planBootSwitch(otadata) {
  var entries = [readEntry(otadata, 0), readEntry(otadata, 1)];
  var newest = -1;
  for (var s = 0; s < 2; s++) {
    if (entries[s].valid && (newest < 0 || entries[s].seq > entries[newest].seq)) newest = s;
  }
  var activeSeq = newest < 0 ? 0 : entries[newest].seq;
  var activeApp = newest < 0 ? 0 : (activeSeq - 1) % 2;
  var targetApp = 1 - activeApp;
  var newSeq = activeSeq + 1;
  while ((newSeq - 1) % 2 !== targetApp) newSeq++;
  return { activeApp: activeApp, targetApp: targetApp, newSeq: newSeq, sector: newest < 0 ? 0 : 1 - newest };
}

// The 32-byte boot selector entry, keeping the old entry's label bytes.
function bootEntry(otadata, plan) {
  var entry = otadata.slice(plan.sector * SECTOR, plan.sector * SECTOR + 32);
  entry.set(le32(plan.newSeq), 0);
  entry.set(le32(OTA_STATE_NEW), 24);
  entry.set(le32(otaSeqCrc(plan.newSeq)), 28);
  return entry;
}

// Runs the install. firmware is a Uint8Array; onStep(index, state) and
// onProgress(fraction) drive the page. Steps: 0 connect, 1 check partitions,
// 2 read boot slot, 3 write firmware, 4 switch boot slot, 5 restart.
async function installX4Pro(firmware, onStep, onProgress) {
  checkS3Image(firmware);
  var esptool = await import(ESPTOOL_URL);
  // Espressif's USB serial/JTAG, which the X4 Pro shows up as (same filter as Inky).
  var port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303A, usbProductId: 0x1001 }] });
  var loader = null;
  var step = 0;
  var silent = { clean: function () {}, writeLine: function () {}, write: function () {} };
  try {
    onStep(0, "running");
    loader = new esptool.ESPLoader({ transport: new esptool.Transport(port, false), baudrate: 115200,
      romBaudrate: 115200, terminal: silent });
    await loader.main();
    if (loader.chip.CHIP_NAME !== "ESP32-S3") {
      throw new Error("That's an " + loader.chip.CHIP_NAME + ", not an X4 Pro. Nothing was written.");
    }
    onStep(0, "done");

    step = 1; onStep(1, "running");
    var layout = parseLayout(await loader.readFlash(PARTITION_TABLE, SECTOR));
    onStep(1, "done");

    step = 2; onStep(2, "running");
    var otadata = await loader.readFlash(layout.otadata.offset, OTADATA_BYTES);
    var plan = planBootSwitch(otadata);
    var slot = layout.apps[plan.targetApp];
    if (firmware.length > slot.size) throw new Error("The firmware doesn't fit in the spare slot. Nothing was written.");
    onStep(2, "done");

    step = 3; onStep(3, "running");
    await loader.writeFlash({
      fileArray: [{ data: loader.ui8ToBstr(firmware), address: slot.offset }],
      flashSize: "keep", flashMode: "keep", flashFreq: "keep", eraseAll: false, compress: true,
      reportProgress: function (_i, written, total) { onProgress(written / total); }
    });
    onStep(3, "done");

    step = 4; onStep(4, "running");
    await loader.writeFlash({
      fileArray: [{ data: loader.ui8ToBstr(bootEntry(otadata, plan)), address: layout.otadata.offset + plan.sector * SECTOR }],
      flashSize: "keep", flashMode: "keep", flashFreq: "keep", eraseAll: false, compress: true
    });
    var check = planBootSwitch(await loader.readFlash(layout.otadata.offset, OTADATA_BYTES));
    if (check.activeApp !== plan.targetApp) throw new Error("The boot slot didn't switch. The old firmware will still start.");
    onStep(4, "done");

    step = 5; onStep(5, "running");
    await loader.after("hard_reset");
    await loader.transport.disconnect();
    loader = null;
    onStep(5, "done");
  } catch (e) {
    onStep(step, "failed");
    throw e;
  } finally {
    if (loader) { try { await loader.transport.disconnect(); } catch (_e) {} }
  }
}

if (typeof module !== "undefined") {
  module.exports = { otaSeqCrc: otaSeqCrc, parseLayout: parseLayout, planBootSwitch: planBootSwitch,
    bootEntry: bootEntry, checkS3Image: checkS3Image };
}
