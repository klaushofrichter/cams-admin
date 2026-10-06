// sim-local.cjs (copied from cams scripts/livestack): cam-sim's CLI, but with every listener
// on 127.0.0.1. Run by scripts/localstack/start.sh.
//
// cam-sim's CLI binds all interfaces, and a preload like bind-local.cjs
// would not reach MediaMTX (a separate binary cam-sim starts for RTSP). Only
// cam-sim's own listen(ports, host) puts both its Node servers and MediaMTX's
// RTSP on one host, so this file repeats the CLI's few lines with
// listen({}, '127.0.0.1'): {} keeps the ports from the configuration.
//
// Configuration comes from CAMSIM_* as usual (cam-sim README);
// LIVESTACK_CAMSIM_DIR is the built cam-sim worktree whose dist/ is loaded.
// If cam-sim's CLI or its exports change, update this file to match.
'use strict';
const { join } = require('path');

const dir = process.env.LIVESTACK_CAMSIM_DIR;
if (!dir) {
  process.stderr.write('sim-local: LIVESTACK_CAMSIM_DIR is not set\n');
  process.exit(2);
}
const { loadConfig, ConfigError } = require(join(dir, 'dist/src/config'));
const { createLogger } = require(join(dir, 'dist/src/log'));
const { createCamSim } = require(join(dir, 'dist/src/index'));

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`cam-sim: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  const log = createLogger(config.logLevel);
  const sim = await createCamSim({ users: config.users, log }, config);
  const ports = await sim.listen({}, '127.0.0.1');
  log.info({ name: config.name, ports, host: '127.0.0.1' }, 'cam_sim_listening');
  const stop = async (signal) => {
    log.info({ signal }, 'cam_sim_stopping');
    await sim.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

main().catch((e) => {
  process.stderr.write(`cam-sim: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
