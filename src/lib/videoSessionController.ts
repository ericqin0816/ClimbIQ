import { prepareVideo, type PreparedVideo } from "./preparedVideo";

/** Owns candidate decoders. A late or cancelled candidate can never become current. */
export class VideoSessionController {
  private preparation: AbortController | null = null;

  constructor(private readonly decode = prepareVideo) {}

  beginPreparation(): AbortController {
    this.cancelPreparation();
    const ticket = new AbortController();
    this.preparation = ticket;
    return ticket;
  }

  isCurrent(ticket: AbortController): boolean {
    return this.preparation === ticket && !ticket.signal.aborted;
  }

  async prepare(file: File, ticket: AbortController, contextIsCurrent: () => boolean): Promise<PreparedVideo> {
    const candidate = await this.decode(file, { signal: ticket.signal });
    if (!this.isCurrent(ticket) || !contextIsCurrent()) {
      candidate.dispose();
      throw new DOMException("Video preparation was cancelled.", "AbortError");
    }
    return candidate;
  }

  finishPreparation(ticket: AbortController): boolean {
    if (this.preparation !== ticket) return false;
    this.preparation = null;
    return true;
  }

  cancelPreparation(): void {
    this.preparation?.abort();
    this.preparation = null;
  }
}
