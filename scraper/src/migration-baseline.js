"use strict";

// The September 2026 squash changed these already-deployed baseline files.
// Accept only the known old -> final checksums. Baseline transitions require
// the matching compatibility bridge; an explicitly marked post-apply fix may
// advance an already-recorded migration without replaying its SQL.
module.exports = {
  // The versioned-state migration was corrected after the first deployment;
  // existing volumes already contain its objects and must only advance the
  // ledger checksum instead of replaying the non-reversible DDL.
  "25-versioned-listing-state.sql": {
    previous: [
      "60d346e2bad6077f79699342afaec6171578887847f968e80204e0722ffbf528",
    ],
    current:
      "89d5ef375ad7193d081a665c093018183589014cae2ea248a9007dd20b441c42",
    allowAfterApply: true,
  },
  "20-child-indexes.sql": {
    previous: [
      "566c0c1021f5c762dc218f137c7ef9b43ecb0a60d984942585a8ff7441376cfe",
    ],
    current: "cfcb69cd2d4390333559fe306fdd061dafdc9814980018b7a4b1da1eafee5dae",
    allowAfterApply: true,
  },
  "24-index-dedup.sql": {
    previous: [
      "58f6e193971986d6f0f7c1a5da1f152244441fd4bb5e8732d83c2a43d0d540a2",
    ],
    current: "a1fb6c38f8c1094bfd5a6f1826110e794ea07a25b2e06ad575c549ee9556937d",
    allowAfterApply: true,
  },
  // Migration 18 was corrected to be safe when Docker initialization and the
  // application migrator both execute it. Existing volumes may already carry
  // the pre-correction checksum; accept that exact transition once.
  "18-performance-maintenance.sql": {
    previous: [
      "38afafc246a7b1e7dc03c650b2971c1d6931cde038269eb20cf251296026fb8b",
    ],
    current: "61fcf6ed8b20d077cdab9b89291d6388becc67f354c7fec7e8ccb1e20ac6c109",
    allowAfterApply: true,
  },
  "04-source-views.sql": {
    previous: [
      "2e651714943ef45b0868bf9eb7c749ecfab2dc57ec6b4f6cebafb9d050f73647",
      // Deployed baseline with the article-scoped price-evidence optimization.
      "c4fe57216989503928bd20febeb909034dcae72577ccea5302a1b91cfbcf395a",
    ],
    current: "d30f9d81ce2810cbf9c210d6462637f788d5ee74f1aa79e1e00c373ef0860acd",
  },
  "08-triggers.sql": {
    previous: [
      "893d33de7e795648a2012c6e1d4c7848d669b1516727a4c69d297aa3972db52a",
    ],
    current: "298dd179c3fa6b63306404651c52703b7db7eab99f6ffa470f6e7baa9d4e175d",
  },
  "13-olap-refresh.sql": {
    previous: [
      "17c630c93af8ee65efafb5aa738d37375b5c9bf8252f515e4782b166650eb62c",
    ],
    current: "5bedab8f13ae0c638ecfdc5c68ae4140271588853002cc1c3aca6136ca6247c2",
  },
  "14-reporting-surface.sql": {
    previous: [
      "a1da8da10b17c4b2b6306f0cf9106b6ad0092f14a27e80d2207f8b5a9351458d",
    ],
    current: "caf89c5b7944b3529082a8f8e7e3102b08a8b9de80366f0143f06880782f789c",
  },
  "15-data-contracts.sql": {
    previous: [
      "643ff271c445dd5e709135a9a92e224c7fb499d7e6d4b0b8405c9c2cca844ed6",
    ],
    current: "e23ffbd45b5a090fd2830b3022491dd49a7b3bcbd2dc81c332fb8e2a68cca58e",
  },
};
