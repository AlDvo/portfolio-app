/**
 * Клиент автоматической оценки облигации.
 *
 * Промпт собирается локально и уходит на Cloudflare Worker, который держит ключ Gemini.
 * Ключ намеренно не покидает Worker: сайт статический и лежит на публичных GitHub Pages.
 */

const CONFIGURED_ENDPOINT = import.meta.env.VITE_RATING_API_URL?.trim() ?? '';

/**
 * Причина сбоя отделена от текста: «упёрлись в лимит», «неверный токен» и «Worker
 * недоступен» требуют от пользователя разных действий, а раньше приходилось читать
 * сообщение и гадать.
 */
export type RatingErrorKind = 'quota' | 'auth' | 'network' | 'server';

export class RatingError extends Error {
  readonly kind: RatingErrorKind;

  constructor(kind: RatingErrorKind, message: string) {
    super(message);
    this.name = 'RatingError';
    this.kind = kind;
  }
}

function kindForStatus(status: number): RatingErrorKind {
  if (status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  return 'server';
}

export interface RatingSource {
  title: string;
  uri: string;
}

export interface RatingResult {
  text: string;
  sources: RatingSource[];
  model?: string;
}

/** В dev идём через прокси Vite на локальный `wrangler dev` (см. vite.config.ts). */
const DEV_ENDPOINT = '/api/rating';

/**
 * Токен доступа к Worker'у живёт только в памяти вкладки: намеренно не пишем его
 * в localStorage/sessionStorage и не берём из VITE_-переменных, иначе он попал бы
 * в публичный бандл или пережил бы вкладку на чужом компьютере.
 */
let accessToken = '';

export function setAccessToken(token: string): void {
  accessToken = token.trim();
}

export function hasAccessToken(): boolean {
  return accessToken !== '';
}

/**
 * Автоматический режим доступен, если задан VITE_RATING_API_URL (в проде это
 * Actions variable с URL Worker'а) либо мы в dev-режиме рядом с wrangler dev.
 */
export const autoRatingAvailable = import.meta.env.DEV || CONFIGURED_ENDPOINT !== '';

export const ratingEndpoint = CONFIGURED_ENDPOINT || DEV_ENDPOINT;

/** Gemini с grounding думает минутами — стандартный таймаут fetch слишком короткий. */
const REQUEST_TIMEOUT_MS = 300_000;

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error !== '') return data.error;
  } catch {
    // ответ не JSON — покажем статус
  }
  return `Сервер ответил HTTP ${response.status}`;
}

export async function requestRating(prompt: string): Promise<RatingResult> {
  let response: Response;
  try {
    response = await fetch(ratingEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new RatingError('network', 'Gemini не ответил за 5 минут.');
    }
    throw new RatingError('network', 'Не удалось соединиться с Worker.');
  }

  if (!response.ok) {
    throw new RatingError(kindForStatus(response.status), await readError(response));
  }

  const data = (await response.json()) as Partial<RatingResult>;
  if (typeof data.text !== 'string' || data.text.trim() === '') {
    throw new Error('Сервер вернул пустой ответ');
  }

  return {
    text: data.text,
    sources: Array.isArray(data.sources) ? data.sources : [],
    model: typeof data.model === 'string' ? data.model : undefined,
  };
}
