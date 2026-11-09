import { z } from "zod";

export const SOURCE_URL =
  "https://domstoldk.euwest01.umbraco.io/selvbetjening/blanketter-og-vejledninger/minskiftesagdk/api-tilslutning-til-skifteportalen/";

const resourceSchema = z.object({
  url: z.url(),
  label: z.string().min(1),
  status: z.union([z.literal(200), z.literal(404), z.literal(410)]),
  hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).refine((resource) => (resource.status === 200) === (resource.hash !== null));

export const snapshotSchema = z.object({
  version: z.literal(1),
  sourceUrl: z.literal(SOURCE_URL),
  checkedAt: z.iso.datetime(),
  pageText: z.string().min(1),
  resources: z.array(resourceSchema).min(1),
}).refine((snapshot) =>
  new Set(snapshot.resources.map((resource) => resource.url)).size === snapshot.resources.length,
);

export type Resource = z.infer<typeof resourceSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;

export interface StateStore {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
}

export type Notify = (messages: string[]) => Promise<void>;
