{
  description = "SubMiner — Japanese sentence mining with mpv + Yomitan";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" ];
      perSystem = { pkgs, ... }: let
        inherit (pkgs) lib stdenv bun makeWrapper symlinkJoin nodejs esbuild typescript runCommand electron_39;
      in {
        packages.default = let
          version = "0.17.2-niri";
          src = ./.;

          electronApp = stdenv.mkDerivation {
            name = "subminer-${version}-electron";
            inherit src;
            nativeBuildInputs = [ bun nodejs esbuild typescript ];
            buildPhase = ''
              export HOME=$TMPDIR/home
              bun install --frozen-lockfile 2>&1
              cd vendor/texthooker-ui && bun install --frozen-lockfile 2>&1
              cd $src
              cd stats && bun install --frozen-lockfile 2>&1 && bun run build 2>&1
              cd $src
              bun run build:renderer 2>&1
              bun run build:settings 2>&1
              tsc -p tsconfig.json 2>&1
            '';
            installPhase = ''
              mkdir -p $out/share/subminer
              cp -r dist build package.json node_modules $out/share/subminer/
              chmod -R u+w $out/share/subminer/build/yomitan
            '';
          };

          appBin = runCommand "subminer-bin" {
            nativeBuildInputs = [ makeWrapper ];
          } ''
            mkdir -p $out/bin
            makeWrapper ${electron_39}/bin/electron $out/bin/SubMiner \
              --add-flags ${electronApp}/share/subminer \
              --add-flags "--no-sandbox" \
              --set-default ELECTRON_OZONE_PLATFORM_HINT "x11"
          '';

          launcher = runCommand "subminer-launcher" {
            nativeBuildInputs = [ makeWrapper ];
          } ''
            mkdir -p $out/bin $out/share/SubMiner/{plugin/subminer,themes}
            cp ${electronApp}/share/subminer/dist/launcher/subminer $out/bin/subminer
            chmod +x $out/bin/subminer
            wrapProgram $out/bin/subminer \
              --set SUBMINER_APPIMAGE_PATH ${appBin}/bin/SubMiner \
              --prefix PATH : ${lib.getExe bun}
            cp -r ${src}/plugin/subminer/* $out/share/SubMiner/plugin/subminer/
            cp ${src}/assets/themes/subminer.rasi $out/share/SubMiner/themes/subminer.rasi
          '';

        in symlinkJoin {
          name = "subminer-${version}";
          paths = [ launcher appBin electronApp ];
          meta = {
            description = "Japanese sentence mining overlay with mpv + Yomitan";
            homepage = "https://github.com/AnonMiraj/SubMiner";
            license = lib.licenses.gpl3Only;
            platforms = lib.platforms.linux;
          };
        };
      };
    };
}
