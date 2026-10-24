# LCTNative - in-process chat translation overlay for Deadlock.
#
# Build (requires VS2022 Build Tools with the C++ workload):
#   cmake -B build -A x64
#   cmake --build build --config Release
#
# The result is build/LCTNative.dll. See native/README.md for details and
# native/docs/DESIGN.md for the architecture and its limitations.

cmake_minimum_required(VERSION 3.21)

project(LCTNative LANGUAGES CXX)

if (NOT WIN32)
  message(FATAL_ERROR "LCTNative is Windows-only (Direct2D/DirectWrite/WinHTTP).")
endif()

if (NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "LCTNative must be built for x64. Configure with: cmake -B build -A x64")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Static MSVC runtime: the DLL is dropped next to the game and injected, so it
# must not depend on a separately installed VC++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(LCT_SOURCES
  src/dllmain.cpp
  src/app.cpp
  src/core/log.cpp
  src/core/util.cpp
  src/core/config.cpp
  src/core/log_tail.cpp
  src/core/translate_client.cpp
  src/overlay/d3d11_overlay.cpp
  src/hooks/sigscan.cpp
)

add_library(LCTNative SHARED ${LCT_SOURCES})

target_include_directories(LCTNative PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_compile_definitions(LCTNative PRIVATE
  UNICODE
  _UNICODE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
  _CRT_SECURE_NO_WARNINGS
)

target_compile_options(LCTNative PRIVATE /W4 /utf-8 /permissive-)

# d3d11_overlay.cpp catches exceptions (including SEH, via catch(...)) around the
# best-effort drawing so a drawing failure can never escape into the game's
# Present call. /EHa is what makes catch(...) cover structured exceptions too.
set_source_files_properties(src/overlay/d3d11_overlay.cpp PROPERTIES COMPILE_OPTIONS "/EHa")

target_link_libraries(LCTNative PRIVATE
  d3d11
  d2d1
  dwrite
  dxgi
  winhttp
  shell32
  user32
  ole32
)

# Keep every artifact directly in build/ (the Visual Studio generator appends a
# per-config subdirectory unless each output directory is pinned).
set(LCT_OUTPUT_DIR ${CMAKE_BINARY_DIR})
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${LCT_OUTPUT_DIR})
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${LCT_OUTPUT_DIR})
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${LCT_OUTPUT_DIR})
foreach(CONFIG_NAME IN ITEMS DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_${CONFIG_NAME} ${LCT_OUTPUT_DIR})
  set(CMAKE_LIBRARY_OUTPUT_DIRECTORY_${CONFIG_NAME} ${LCT_OUTPUT_DIR})
  set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY_${CONFIG_NAME} ${LCT_OUTPUT_DIR})
endforeach()

set_target_properties(LCTNative PROPERTIES
  OUTPUT_NAME "LCTNative"
  PDB_OUTPUT_DIRECTORY ${LCT_OUTPUT_DIR}
  COMPILE_PDB_OUTPUT_DIRECTORY ${LCT_OUTPUT_DIR}
)

# Keep warnings visible during review without breaking unrelated builds.
if (MSVC)
  add_compile_options(/WX-)
endif()
