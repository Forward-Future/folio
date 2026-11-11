declare module "bidi-js" {
  interface Levels { levels: Uint8Array }
  export default function bidiFactory(): {
    getEmbeddingLevels(text: string): Levels;
    getReorderedIndices(text: string, levels: Levels): number[];
  };
}
