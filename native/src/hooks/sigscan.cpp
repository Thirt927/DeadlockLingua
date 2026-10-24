#include "hooks/sigscan.h"

#include <cstddef>
#include <cstring>
#include <string>

namespace lct {
namespace {

bool IsHexDigit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

int HexDigitValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

}  // namespace

bool ParsePattern(const char* pattern, std::vector<PatternByte>& out) {
  out.clear();
  if (pattern == nullptr) return false;

  std::string token;
  for (const char* cursor = pattern;; ++cursor) {
    const char c = *cursor;
    if (c == '\0' || c == ' ' || c == '\t') {
      if (!token.empty()) {
        PatternByte byte;
        if (token == "?" || token == "??") {
          byte.wildcard = true;
        } else {
          if (token.size() != 2 || !IsHexDigit(token[0]) || !IsHexDigit(token[1])) return false;
          byte.value = static_cast<uint8_t>((HexDigitValue(token[0]) << 4) | HexDigitValue(token[1]));
        }
        out.push_back(byte);
        token.clear();
      }
      if (c == '\0') break;
      continue;
    }
    token.push_back(c);
    if (token.size() > 2) return false;
  }
  return !out.empty();
}

uint8_t* FindPatternInRange(const uint8_t* begin, size_t size, const std::vector<PatternByte>& pattern) {
  if (begin == nullptr || pattern.empty() || size < pattern.size()) return nullptr;
  const size_t lastOffset = size - pattern.size();
  for (size_t offset = 0; offset <= lastOffset; ++offset) {
    bool matched = true;
    for (size_t i = 0; i < pattern.size(); ++i) {
      if (!pattern[i].wildcard && begin[offset + i] != pattern[i].value) {
        matched = false;
        break;
      }
    }
    if (matched) return const_cast<uint8_t*>(begin + offset);
  }
  return nullptr;
}

bool GetModuleRange(HMODULE module, uint8_t** base, size_t* size) {
  if (base == nullptr || size == nullptr) return false;
  const HMODULE resolved = module != nullptr ? module : GetModuleHandleW(nullptr);
  if (resolved == nullptr) return false;

  const auto* imageBase = reinterpret_cast<const uint8_t*>(resolved);
  const auto* dosHeader = reinterpret_cast<const IMAGE_DOS_HEADER*>(imageBase);
  if (dosHeader->e_magic != IMAGE_DOS_SIGNATURE) return false;
  if (dosHeader->e_lfanew <= 0) return false;

  const auto* ntHeaders = reinterpret_cast<const IMAGE_NT_HEADERS*>(imageBase + dosHeader->e_lfanew);
  if (ntHeaders->Signature != IMAGE_NT_SIGNATURE) return false;
  if (ntHeaders->OptionalHeader.SizeOfImage == 0) return false;

  *base = const_cast<uint8_t*>(imageBase);
  *size = ntHeaders->OptionalHeader.SizeOfImage;
  return true;
}

uint8_t* FindPatternInModule(HMODULE module, const char* pattern) {
  std::vector<PatternByte> parsed;
  if (!ParsePattern(pattern, parsed)) return nullptr;

  uint8_t* base = nullptr;
  size_t size = 0;
  if (!GetModuleRange(module, &base, &size)) return nullptr;

  const auto* dosHeader = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
  const auto* ntHeaders = reinterpret_cast<const IMAGE_NT_HEADERS*>(base + dosHeader->e_lfanew);
  const IMAGE_SECTION_HEADER* section = IMAGE_FIRST_SECTION(ntHeaders);
  for (unsigned index = 0; index < ntHeaders->FileHeader.NumberOfSections; ++index, ++section) {
    if ((section->Characteristics & IMAGE_SCN_MEM_EXECUTE) == 0) continue;
    const size_t sectionSize =
        section->Misc.VirtualSize != 0 ? section->Misc.VirtualSize : section->SizeOfRawData;
    if (sectionSize < parsed.size()) continue;
    uint8_t* match = FindPatternInRange(base + section->VirtualAddress, sectionSize, parsed);
    if (match != nullptr) return match;
  }
  return nullptr;
}

uint8_t* ResolveRipRelative(const uint8_t* instruction, size_t operandOffset, size_t instructionLength) {
  if (instruction == nullptr) return nullptr;
  int32_t displacement = 0;
  std::memcpy(&displacement, instruction + operandOffset, sizeof(displacement));
  return const_cast<uint8_t*>(instruction + instructionLength + static_cast<std::ptrdiff_t>(displacement));
}

}  // namespace lct
