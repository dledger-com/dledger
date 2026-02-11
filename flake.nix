{
  description = "A Nix-flake-based Rust development environment";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1"; # unstable Nixpkgs
    fenix = {
      url = "https://flakehub.com/f/nix-community/fenix/0.1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {self, ...} @ inputs: let
    supportedSystems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    forEachSupportedSystem = f:
      inputs.nixpkgs.lib.genAttrs supportedSystems (
        system:
          f {
            pkgs = import inputs.nixpkgs {
              inherit system;
              overlays = [
                inputs.self.overlays.default
              ];
            };
          }
      );
  in {
    overlays.default = final: prev: {
      rustToolchain = with inputs.fenix.packages.${prev.stdenv.hostPlatform.system};
        combine (
          with stable; [
            clippy
            rustc
            cargo
            rustfmt
            rust-src
          ]
        );
    };

    devShells = forEachSupportedSystem (
      {pkgs}: let
        libraries = with pkgs; [
          # Tauri dependencies
          at-spi2-atk
          atkmm
          cairo
          # cargo-tauri # Optional, only needed if Tauri doesn't work through the traditional way
          dbus
          gdk-pixbuf
          glib
          glib-networking # Most Tauri apps need networking
          gobject-introspection
          gtk3
          harfbuzz
          librsvg
          libsoup_3
          openssl
          pango
          webkitgtk_4_1
        ];
      in {
        default = pkgs.mkShell {
          packages = with pkgs;
            [
              rustToolchain
              pkg-config
              cargo-deny
              cargo-edit
              cargo-watch
              rust-analyzer

              # Tauri frontend
              bun
              nodejs # Optional, this is for if you have a js frontend
            ]
            ++ libraries;

          env = {
            # Required by rust-analyzer
            RUST_SRC_PATH = "${pkgs.rustToolchain}/lib/rustlib/src/rust/library";

            # Tauri
            # https://v1.tauri.app/v1/guides/getting-started/prerequisites/#setting-up-linux
            LD_LIBRARY_PATH = "${pkgs.lib.makeLibraryPath libraries}:$LD_LIBRARY_PATH";
            XDG_DATA_DIRS = "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS";

            # Workaround bug with Tauri on Wayland / NVIDIA
            # https://github.com/tauri-apps/tauri/issues/10702
            # WEBKIT_DISABLE_DMABUF_RENDERER = 1;
            __NV_DISABLE_EXPLICIT_SYNC = 1;
          };
        };
      }
    );
  };
}
