import type { Logging } from 'homebridge';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * Wraps ONE shairport-sync process advertising a single AirPlay receiver (one
 * zone). shairport-sync is a native binary that must be installed on the
 * Homebridge host and built with the `stdout` output backend; it decodes the
 * AirPlay stream to raw PCM (44100/16/2) on stdout, which we re-serve to the
 * Raumfeld renderer (see {@link AirPlayStreamServer}).
 *
 * Session presence is inferred from the PCM flow: shairport-sync only writes to
 * stdout while an iOS device is streaming, so the first chunk means "playing"
 * and a gap means "stopped". That drives the renderer's Play/Stop.
 *
 * NOTE on AirPlay 2: running many receivers is simplest in AirPlay-1 mode (one
 * self-contained process per zone). AirPlay-2 needs a shared nqptp and does not
 * multi-instance cleanly, so this wrapper passes no AP2-specific flags.
 */
export interface ReceiverCallbacks {
  /** Fired when audio starts; hand the live PCM stream to the stream server. */
  onSessionStart(pcm: Readable): void;
  /** Fired after the stream has been idle past the silence timeout. */
  onSessionEnd(): void;
}

/** Milliseconds of no PCM before a session is considered ended. */
const IDLE_TIMEOUT_MS = 2000;

export class AirPlayReceiver {
  private child?: ChildProcessWithoutNullStreams;
  private active = false;
  private idleTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly log: Logging,
    private readonly binaryPath: string,
    /** AirPlay service name shown in the iOS output picker. */
    private readonly name: string,
    /** RTSP port; must be unique per concurrent receiver. */
    private readonly rtspPort: number,
    private readonly callbacks: ReceiverCallbacks,
  ) {}

  /** True if the configured shairport-sync binary runs and reports a version. */
  static available(binaryPath: string): boolean {
    try {
      const res = spawnSync(binaryPath, ['-V'], { timeout: 4000 });
      return res.status === 0 || (res.stdout?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.child) return;
    this.stopped = false;
    const args = [
      '-a', this.name,          // advertised AirPlay name
      '-o', 'stdout',           // raw PCM on stdout
      '--port', String(this.rtspPort),
    ];
    this.log.debug(`AirPlay: spawning ${this.binaryPath} ${args.join(' ')}`);
    const child = spawn(this.binaryPath, args);
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.onPcm(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) this.log.debug(`AirPlay[${this.name}] shairport: ${line}`);
    });
    child.once('error', (err) => {
      this.log.error(`AirPlay[${this.name}] failed to start shairport-sync: ${err.message}`);
      this.child = undefined;
    });
    child.once('exit', (code, signal) => {
      if (!this.stopped) {
        this.log.warn(`AirPlay[${this.name}] shairport-sync exited (code ${code}, signal ${signal}).`);
      }
      this.endSession();
      this.child = undefined;
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.endSession();
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }

  private onPcm(chunk: Buffer): void {
    if (!this.active) {
      this.active = true;
      this.log.info(`AirPlay: session started on "${this.name}".`);
      // stdout is the live PCM source; hand it to the stream server.
      if (this.child) this.callbacks.onSessionStart(this.child.stdout);
    }
    // Reset the idle watchdog on every chunk; a gap ends the session.
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.endSession(), IDLE_TIMEOUT_MS);
    void chunk;
  }

  private endSession(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.active) return;
    this.active = false;
    this.log.info(`AirPlay: session ended on "${this.name}".`);
    this.callbacks.onSessionEnd();
  }
}
