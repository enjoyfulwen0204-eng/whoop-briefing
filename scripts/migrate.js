#!/usr/bin/env node
// This compatibility name delegates to the reviewed controlled migration tool.
// Its explicit arguments, Node/key/target guards and postconditions are mandatory.
import {main,safeMigrationError} from './phase4-migrate.js';
try{await main();}catch(error){console.error(JSON.stringify(safeMigrationError(error)));process.exitCode=1;}
