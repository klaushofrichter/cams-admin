// bind-local.cjs (copied from cams scripts/livestack): preloaded into cam-proxy by the
// cams-admin local stack (scripts/localstack/start.sh).
//
// Every TCP listener that would bind all interfaces (no host, 0.0.0.0 or ::)
// binds LIVESTACK_BIND (default 127.0.0.1) instead. Neither app has a bind
// option, and a local run must stay off the LAN: this covers cams' HTTP
// server and cam-proxy's HTTP API and FTP server (control and passive data
// ports). Unix sockets, handles, fds and explicit hosts are left alone.
// go2rtc and ffmpeg are separate binaries, not covered here; cam-proxy
// already binds go2rtc to 127.0.0.1.
//
// It works by wrapping net.Server.prototype.listen, which every Node server
// (http, https, net, the FTP library) goes through, and rewriting only the
// host argument of its call forms.
'use strict';
const net = require('net');

const BIND = process.env.LIVESTACK_BIND || '127.0.0.1';
const WILD = new Set(['0.0.0.0', '::', '']);
const orig = net.Server.prototype.listen;

net.Server.prototype.listen = function patchedListen(...args) {
  // listen() / listen(cb) / listen(undefined, ...): a random port.
  if (args.length === 0 || typeof args[0] === 'function') args.unshift(0);
  else if (args[0] === undefined || args[0] === null) args[0] = 0;
  const a0 = args[0];
  if (typeof a0 === 'object' && !Array.isArray(a0)) {
    // listen(options[, cb]); a handle, fd or path is not a TCP port.
    if (a0.path === undefined && a0.handle === undefined && a0._handle === undefined && a0.fd === undefined) {
      if (a0.host === undefined || a0.host === null || WILD.has(a0.host)) args[0] = { ...a0, host: BIND };
    }
  } else if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {
    // listen(port[, host][, backlog][, cb])
    const a1 = args[1];
    if (typeof a1 === 'string') {
      if (WILD.has(a1)) args[1] = BIND;
    } else if (args.length > 1 && (a1 === undefined || a1 === null)) {
      args[1] = BIND;
    } else {
      args.splice(1, 0, BIND);
    }
  }
  return orig.apply(this, args);
};
