// Signature scanner used by the (not yet implemented) Tier 2 Panorama hook.
//
// TIER 2 SCAFFOLDING: nothing in this build calls these helpers. They are here
// so the Panorama work starts from a reviewed scanner instead of ad-hoc byte
// searching. See native/docs/DESIGN.md, section "Tier 2".
#pragma once

#include <windows.h>

#include <cstddef>
#include <cstdint>
#include <vector>

namespace lct {

struct PatternByte {
  uint8_t value = 0;
  bool wildcard = false;
};

// Parses patterns such as "48 8B ?? ?? E8" ("?" or "??" are wildcards).
bool ParsePattern(const char* pattern, std::vector<PatternByte>& out);

// First match inside [begin, begin + size), or nullptr.
uint8_t* FindPatternInRange(const uint8_t* begin, size_t size, const std::vector<PatternByte>& pattern);

// Scans the executable sections of `module` (nullptr = the main game module).
uint8_t* FindPatternInModule(HMODULE module, const char* pattern);

// Resolves a RIP-relative operand: target = instruction + instructionLength +
// int32 displacement read at instruction + operandOffset.
uint8_t* ResolveRipRelative(const uint8_t* instruction, size_t operandOffset, size_t instructionLength);

// Mapped range of a module image in the current process.
bool GetModuleRange(HMODULE module, uint8_t** base, size_t* size);

}  // namespace lct
