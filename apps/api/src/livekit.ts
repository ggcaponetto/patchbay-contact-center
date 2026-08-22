import type { ParticipantAttributes } from '@cc/shared';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

const AGENT_NAME = 'cc-agent';

type TokenRequest = {
  room: string;
  identity: string;
  name: string;
  attributes: ParticipantAttributes;
  canPublish?: boolean;
  /** Dispatch the AI agent with this metadata when the room is created. */
  dispatchMetadata?: string;
};

/** Everything the API needs from LiveKit, so tests can swap in a fake. */
export type LiveKit = {
  url: string;
  createToken(req: TokenRequest): Promise<string>;
  dispatchAgent(room: string, metadata: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
};

/** Real LiveKit Cloud client built from `LIVEKIT_*` env vars. */
export function createLiveKit(): LiveKit {
  const url = process.env.LIVEKIT_URL ?? '';
  const apiKey = process.env.LIVEKIT_API_KEY ?? '';
  const apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
  if (!url || !apiKey || !apiSecret) throw new Error('LIVEKIT_URL/API_KEY/API_SECRET are not set');
  const httpUrl = url.replace(/^ws/, 'http');
  const rooms = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  const dispatch = new AgentDispatchClient(httpUrl, apiKey, apiSecret);
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
  };
}

const stripUndefined = (o: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined));
