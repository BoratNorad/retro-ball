import { type GameData } from "@tdf/shared";
export declare const ROOT: string;
export declare const SHARED: string;
export declare function readShared(rel: string): unknown;
export declare function nodeGameData(): Promise<GameData>;
