"use strict";

module.exports = {
  Db: require("./client"),
  applyMigrations: require("./migrate"),
  get config() {
    return require("./config");
  },
};
