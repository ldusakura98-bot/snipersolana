import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { log } from './logger.js';

export interface RiskLimits {
  /** Pérdida máxima por día (UTC) en SOL; al alcanzarla no se abren más posiciones (0 = sin límite). */
  maxDailyLossSol: number;
  /** Tras N operaciones perdedoras seguidas, pausa de `cooldownMinutes` (0 = sin límite). */
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
}

interface RiskState {
  day: string;
  pnlSol: number;
  consecutiveLosses: number;
  pausedUntil: number;
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Controla cuánto se puede perder antes de dejar de comprar. Persiste en disco para sobrevivir reinicios. */
export class RiskManager {
  private state: RiskState;

  constructor(
    private readonly limits: RiskLimits,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.state = { day: today(this.now()), pnlSol: 0, consecutiveLosses: 0, pausedUntil: 0 };
    if (file) {
      try {
        this.state = { ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        /* primer arranque */
      }
    }
  }

  /** ¿Se puede abrir una posición nueva? */
  canOpen(): { ok: true } | { ok: false; reason: string } {
    this.rollDay();
    const { maxDailyLossSol } = this.limits;
    if (maxDailyLossSol > 0 && this.state.pnlSol <= -maxDailyLossSol) {
      return { ok: false, reason: `pérdida diaria ${this.state.pnlSol.toFixed(4)} SOL ≥ límite ${maxDailyLossSol} SOL (se reanuda mañana, 00:00 UTC)` };
    }
    if (this.state.pausedUntil > this.now()) {
      const min = Math.ceil((this.state.pausedUntil - this.now()) / 60_000);
      return { ok: false, reason: `pausa tras ${this.limits.maxConsecutiveLosses} pérdidas seguidas (quedan ${min} min)` };
    }
    return { ok: true };
  }

  /** Registra el resultado de una venta. `pnlSol` undefined = no se pudo convertir a SOL (solo cuenta la racha). */
  record(isLoss: boolean, pnlSol: number | undefined) {
    this.rollDay();
    if (pnlSol !== undefined) this.state.pnlSol += pnlSol;
    this.state.consecutiveLosses = isLoss ? this.state.consecutiveLosses + 1 : 0;
    const { maxConsecutiveLosses, cooldownMinutes } = this.limits;
    if (maxConsecutiveLosses > 0 && this.state.consecutiveLosses >= maxConsecutiveLosses) {
      this.state.pausedUntil = this.now() + cooldownMinutes * 60_000;
      this.state.consecutiveLosses = 0;
      log.warn(`${maxConsecutiveLosses} pérdidas seguidas: pausa de ${cooldownMinutes} min sin comprar`);
    }
    this.save();
  }

  get pnlTodaySol(): number {
    this.rollDay();
    return this.state.pnlSol;
  }

  private rollDay() {
    const d = today(this.now());
    if (d !== this.state.day) this.state = { ...this.state, day: d, pnlSol: 0 };
  }

  private save() {
    if (!this.file) return;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
