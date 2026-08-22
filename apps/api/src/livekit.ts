/**
 * The API's view of LiveKit Cloud: mint join tokens, dispatch the AI agent, delete rooms.
 *
 * The API never joins a room itself. It only:
 *
 * - signs short-lived JWTs so customers (embed), human agents and supervisors (desk) can
 *   join the call's room with the right identity, display name and attributes,
 * - asks LiveKit to start the AI agent worker (`cc-agent`) in a room, either eagerly via
 *   the token's room configuration or later through the dispatch API,
 * - deletes the room when the call ends, which disconnects everyone still inside.
 *
 * Everything is behind the {@link LiveKit} interface so tests can use `fakeLiveKit()`
 * from `testing.ts` and never touch the network.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import type { ParticipantAttributes } from '@cc/shared';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

/** Must match the `agentName` the worker registers with (see `apps/agent`). */
const AGENT_NAME = 'cc-agent';

/** What a caller of {@link LiveKit.createToken} must provide. */
type TokenRequest = {
  /** Room name, see `roomNameFor` in `@cc/shared`. */
  room: string;
  /** Participant identity, e.g. `customer:<callId>`, `human:<userId>`, `supervisor:<userId>`. */
  identity: string;
  /** Human-readable name shown by LiveKit clients. */
  name: string;
  /** Attributes visible to every peer in the room (role, userId, displayName). */
  attributes: ParticipantAttributes;
  /** `false` for silent listeners (supervisor "listen" mode). Defaults to `true`. */
  canPublish?: boolean;
  /** Dispatch the AI agent with this metadata when the room is created. */
  dispatchMetadata?: string;
};

/**
 * Everything the API needs from LiveKit, so tests can swap in a fake.
 *
 * Two ways to get the AI agent into a room:
 *
 * - `createToken({ dispatchMetadata })`: the dispatch is embedded in the token's room
 *   configuration, so the agent is started the moment the customer's connection creates
 *   the room. Used for `ai-first` tenants (no extra round-trip, no race).
 * - `dispatchAgent(room, metadata)`: explicit API call for a room that already exists.
 *   Used when human-first ringing gives up and the AI must take over.
 *
 * `metadata` is always a JSON-encoded `DispatchMetadata` (see `@cc/shared`).
 */
export type LiveKit = {
  /** Websocket URL handed to clients together with their token. */
  url: string;
  /** Mints a 2-hour join token for one participant. */
  createToken(req: TokenRequest): Promise<string>;
  /** Starts the AI agent worker in an existing room. */
  dispatchAgent(room: string, metadata: string): Promise<void>;
  /** Deletes the room (kicking everyone). Errors are swallowed; the room may already be gone. */
  deleteRoom(room: string): Promise<void>;
  /** Removes one participant from the room (consult drop). Errors are swallowed. */
  removeParticipant(room: string, identity: string): Promise<void>;
};

/** The two server-API clients {@link createLiveKit} talks to; tests inject fakes. */
export type LiveKitClients = {
  /** `RoomServiceClient` (or a fake): `deleteRoom` and `removeParticipant` are used. */
  rooms: Pick<RoomServiceClient, 'deleteRoom' | 'removeParticipant'>;
  /** `AgentDispatchClient` (or a fake): only `createDispatch` is used. */
  dispatch: Pick<AgentDispatchClient, 'createDispatch'>;
};

/** Builds the real SDK clients against the HTTP(S) form of `LIVEKIT_URL`. */
const sdkClients = (httpUrl: string, apiKey: string, apiSecret: string): LiveKitClients => ({
  rooms: new RoomServiceClient(httpUrl, apiKey, apiSecret),
  dispatch: new AgentDispatchClient(httpUrl, apiKey, apiSecret),
});

/**
 * Real LiveKit Cloud client built from `LIVEKIT_*` env vars.
 *
 * @param clients - Factory for the server-API clients; defaults to the SDK ones. Tests pass
 *   fakes so nothing talks to the network (token minting is local either way).
 * @returns A {@link LiveKit} backed by `livekit-server-sdk`.
 * @throws Error when `LIVEKIT_URL`, `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` is missing.
 */
export function createLiveKit(
  clients: (httpUrl: string, apiKey: string, apiSecret: string) => LiveKitClients = sdkClients,
): LiveKit {
  const url = process.env.LIVEKIT_URL ?? '';
  const apiKey = process.env.LIVEKIT_API_KEY ?? '';
  const apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
  if (!url || !apiKey || !apiSecret) throw new Error('LIVEKIT_URL/API_KEY/API_SECRET are not set');
  // The server APIs are HTTP(S); clients connect over ws(s) to the same host.
  const { rooms, dispatch } = clients(url.replace(/^ws/, 'http'), apiKey, apiSecret);
  return {
    url,
    async createToken(req) {
      const at = new AccessToken(apiKey, apiSecret, {
        identity: req.identity,
        name: req.name,
        attributes: stripUndefined(req.attributes),
        ttl: '2h',
      });
      at.addGrant({
        roomJoin: true,
        room: req.room,
        canPublish: req.canPublish ?? true,
        canSubscribe: true,
        canPublishData: true,
      });
      if (req.dispatchMetadata !== undefined) {
        at.roomConfig = new RoomConfiguration({
          agents: [
            new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: req.dispatchMetadata }),
          ],
        });
      }
      return at.toJwt();
    },
    async dispatchAgent(room, metadata) {
      await dispatch.createDispatch(room, AGENT_NAME, { metadata });
    },
    async deleteRoom(room) {
      await rooms.deleteRoom(room).catch(() => undefined);
    },
    async removeParticipant(room, identity) {
      await rooms.removeParticipant(room, identity).catch(() => undefined);
    },
  };
}

/** LiveKit attributes must be strings; drop optional fields that were left undefined. */
const stripUndefined = (o: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined));
