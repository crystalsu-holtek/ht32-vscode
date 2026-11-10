'use strict';
const vscodeMock = {
  window: { createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }) },
  workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
  ProgressLocation: { Notification: 15 },
};
const Module = require('module');
const _origReq = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'vscode') return vscodeMock;
  return _origReq.apply(this, arguments);
};

const path = require('path');
const fs   = require('fs');
const { keil2gnu, injectStartupInit } = require('../out/tools/uv2make');

const outDir = path.join(__dirname, '_keil2gnu_out');
fs.mkdirSync(outDir, { recursive: true });

const testFiles = [
  // 5xxxx IAP — has INCLUDE + BootProcess (original test case)
  'E:/HT32_STD_5xxxx_FWLib_V1.21.1_9874/application/IAP_HID/IAP_HID_III/MDK_ARMv537/startup_ht32f5xxxx_01.s',
  // 1xxxx IAP — different MCU family, :DEF: patterns, _iap variants
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_HID/IAP_HID_III/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_HID/IAP_HID_III/MDK_ARMv537/startup_ht32f1xxxx_01_iap.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_HID/IAP_HID_III/MDK_ARMv537/startup_ht32f1xxxx_03.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_HID/IAP_HID_III/MDK_ARMv537/startup_ht32f1xxxx_03_iap.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_I2C/IAP_I2C_Device/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_I2C/IAP_I2C_Device/MDK_ARMv537/startup_ht32f1xxxx_01_iap.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_I2C/IAP_I2C_Host/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_SPI/IAP_SPI_Host/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_SPI/IAP_SPI_Slave/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_SPI/IAP_SPI_Slave/MDK_ARMv537/startup_ht32f1xxxx_01_iap.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_UART/IAP_UART_Host/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_UART/IAP_UART_Host/MDK_ARMv537/startup_ht32f1xxxx_03.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_UART/IAP_UART_Slave/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_UART/IAP_UART_Slave/MDK_ARMv537/startup_ht32f1xxxx_01_iap.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_UART/IAP_UART_Slave/MDK_ARMv537/startup_ht32f1xxxx_03.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_UART/IAP_UART_Slave/MDK_ARMv537/startup_ht32f1xxxx_03_iap.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_Virtual_COM/IAP_Virtual_COM/MDK_ARMv537/startup_ht32f1xxxx_01.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_Virtual_COM/IAP_Virtual_COM/MDK_ARMv537/startup_ht32f1xxxx_01_iap.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_Virtual_COM/IAP_Virtual_COM/MDK_ARMv537/startup_ht32f1xxxx_03.s',
  'E:/HT32_STD_1xxxx_FWLib_V1.7.1_3596/application/IAP_Virtual_COM/IAP_Virtual_COM/MDK_ARMv537/startup_ht32f1xxxx_03_iap.s',
];

let passed = 0, failed = 0;
for (const keilFile of testFiles) {
  if (!fs.existsSync(keilFile)) {
    console.log(`SKIP (not found): ${keilFile}`);
    continue;
  }
  try {
    const keilText = fs.readFileSync(keilFile, 'utf8');
    let result = keil2gnu(keilText, path.dirname(keilFile), outDir);
    result = injectStartupInit(result);

    const baseName = path.basename(keilFile, '.s') + '_gcc.s';
    const outFile = path.join(outDir, baseName);
    fs.writeFileSync(outFile, result, 'utf8');

    // Basic sanity checks
    const errors = [];
    if (!result.includes('__StackTop'))      errors.push('missing __StackTop');
    if (!result.includes('__StackLimit'))    errors.push('missing __StackLimit');
    if (!result.includes('__HeapBase'))      errors.push('missing __HeapBase');
    if (!result.includes('__HeapLimit'))     errors.push('missing __HeapLimit');
    if (!result.includes('Reset_Handler'))   errors.push('missing Reset_Handler');
    if (!result.includes('"aw",%nobits'))    errors.push('missing aw,%nobits on stack/heap');
    if (result.includes('"w"'))              errors.push('found bare "w" section flag');
    // Check no mismatched .else/.endif without .if
    const dotIf    = (result.match(/^\t?\.if\b/mg)     || []).length;
    const dotEndif = (result.match(/^\t?\.endif\b/mg)  || []).length;
    if (dotIf !== dotEndif) errors.push(`.if count ${dotIf} ≠ .endif count ${dotEndif}`);

    if (errors.length) {
      console.log(`FAIL: ${path.basename(keilFile)}`);
      errors.forEach(e => console.log(`  - ${e}`));
      failed++;
    } else {
      console.log(`OK:   ${path.basename(keilFile)}`);
      passed++;
    }
  } catch (e) {
    console.log(`ERROR: ${path.basename(keilFile)}: ${e.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
