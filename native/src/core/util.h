// Small shared text / JSON helpers.
//
// There is no third-party dependency in this project (see native/README.md), so
// the few things the DLL needs from JSON are implemented here: enough to read
// native.json and the bridge's {"ok":true,"translation":"..."} response. This
// is deliberately *not* a general-purpose JSON parser.
#pragma once

#include <string>

namespace lct {

// Directory that contains this DLL (no trailing separator), or an empty string.
std::wstring GetModuleDirectory();

// UTF-8 <-> UTF-16. Invalid input is replaced through MultiByteToWideChar's
// default substitution instead of failing.
std::wstring Utf8ToWide(const std::string& in);
std::string WideToUtf8(const std::wstring& in);

// Trims ASCII whitespace from both ends.
std::string TrimAscii(const std::string& in);

// Truncates UTF-8 text to at most `maxBytes` bytes without splitting a
// multi-byte sequence.
std::string TruncateUtf8(const std::string& in, size_t maxBytes);

// Escapes a UTF-8 string so it can be placed between double quotes in a JSON
// document (the quotes themselves are not added).
std::string JsonEscape(const std::string& utf8);

// --- Minimal JSON object access ---------------------------------------------
// Finds a member of the JSON *object* in `json` and stores its raw value text
// (string literal including quotes, number, true/false/null, or balanced
// object/array). Only top-level members are searched; the first match wins.
bool JsonFindMember(const std::string& json, const char* key, std::string& rawOut);

// Converts raw values returned by JsonFindMember into host types.
bool JsonAsString(const std::string& raw, std::string& out);
bool JsonAsBool(const std::string& raw, bool& out);
bool JsonAsDouble(const std::string& raw, double& out);

}  // namespace lct
