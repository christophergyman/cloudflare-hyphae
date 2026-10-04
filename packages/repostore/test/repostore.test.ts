import { MemoryRepoStore } from "../src/index.ts";
import { repoStorePortSuite } from "./suites.ts";

repoStorePortSuite("in-memory", () => new MemoryRepoStore());
