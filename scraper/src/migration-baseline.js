"use strict";

// The September 2026 squash changed these already-deployed baseline files.
// Accept only the known old -> final checksums, and only while the matching
// compatibility bridge is pending. Its SQL and ledger updates commit together.
module.exports = {
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
