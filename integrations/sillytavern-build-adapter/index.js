/* eslint-env browser */
// Build Standalone 0.6.0 snapshot (MIT); formatting adapted for this repository.
import { getContext } from "/scripts/extensions.js";
import * as openAI from "/scripts/openai.js";
import { installSillyTavern } from "./runtime.js?v=0.6.0";

installSillyTavern({ getContext, openAI, owner: "legacy" });
