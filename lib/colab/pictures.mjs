// Making pictures with the board's image model (OpenRouter), for the roles
// allowed to: the generate_image tool's checks, spend and per-turn limit.
import { OpError } from '../board.mjs';
import { OpenRouterError } from './openrouter.mjs';

export const PICTURES_PER_TURN = 2;

export class PictureMaker {
  // Pictures made so far in each author's current turn: author -> { turn, count }.
  #made = new Map();

  constructor({ store, library, openrouter }) {
    this.store = store;
    this.library = library;
    this.openrouter = openrouter;
  }

  // A new go for `author` (a session's wait returned, the binary started a run): its count starts over.
  newTurn(author) {
    this.#made.delete(author);
  }

  // Whether `author`'s role can make pictures: Claude's role is the line-up's
  // claudeRoleId, an agent's is its roster entry's. Unknown authors can't.
  canMake(author) {
    const { lineup, roster } = this.store.board.colab;
    const roleId = author === 'claude' ? lineup.claudeRoleId : roster.find((r) => r.id === author)?.roleId;
    if (!roleId) return false;
    return Boolean(this.library.get().roles.find((r) => r.id === roleId)?.pictures);
  }

  // `signal` cuts the image call short (Stop, a turn's time limit); a picture that comes back
  // after it fired is not saved, though its cost still counts. `onSpend(cost)` hears each cost.
  async make({ author, prompt, signal, onSpend }) {
    if (!this.canMake(author)) throw new OpError('Only roles that can make pictures can use generate_image.');
    const { colab } = this.store.board;
    const model = colab.lineup.imageModel;
    if (!model) throw new OpError('No image model is set; choose one in the sidebar.');
    if ((colab.spent ?? 0) >= colab.lineup.budget) throw new OpError('The budget is used up; raise it or press Reset to make pictures.');
    const turn = this.store.turnOf(author);
    let made = this.#made.get(author);
    if (made?.turn !== turn) made = { turn, count: 0 };
    if (made.count >= PICTURES_PER_TURN) throw new OpError(`Picture limit reached for this turn (${PICTURES_PER_TURN}).`);
    // The slot is taken before the call, so two calls at once can't both pass; a failure gives it back.
    made.count += 1;
    this.#made.set(author, made);
    const spend = (cost) => {
      if (!Number.isFinite(cost) || cost < 0) return;
      this.store.addColabSpend(cost);
      onSpend?.(cost);
    };
    let data;
    try {
      const result = await this.openrouter.image({ model, prompt, signal });
      spend(result.cost);
      data = result.data;
      signal?.throwIfAborted();
    } catch (error) {
      made.count -= 1;
      // Spent once only: a picture cut off after it came back has already been counted.
      if (data === undefined) spend(error?.cost);
      // The model's own failure is reported to the caller like any refused tool call.
      if (error instanceof OpenRouterError) throw new OpError(error.message);
      throw error;
    }
    try {
      return { asset: this.store.assets.ingestBuffer(data).asset };
    } catch (error) {
      made.count -= 1;
      throw error;
    }
  }
}
