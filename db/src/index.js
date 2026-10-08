"use strict";

module.exports = {
  Db: require("./client"),
  applyMigrations: require("./migrate"),
  env: require("./env"),
  get config() {
    return require("./config");
  },
};
