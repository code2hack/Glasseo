import type { TextUnit } from "./types";

type Grapheme = Readonly<{ start: number; end: number; text: string }>;

// Unicode 15.1 DerivedGeneralCategory.txt Letter + Number, merged ranges.
const WORD =
  /^[\u{30}-\u{39}\u{41}-\u{5a}\u{61}-\u{7a}\u{aa}\u{b2}-\u{b3}\u{b5}\u{b9}-\u{ba}\u{bc}-\u{be}\u{c0}-\u{d6}\u{d8}-\u{f6}\u{f8}-\u{2c1}\u{2c6}-\u{2d1}\u{2e0}-\u{2e4}\u{2ec}\u{2ee}\u{370}-\u{374}\u{376}-\u{377}\u{37a}-\u{37d}\u{37f}\u{386}\u{388}-\u{38a}\u{38c}\u{38e}-\u{3a1}\u{3a3}-\u{3f5}\u{3f7}-\u{481}\u{48a}-\u{52f}\u{531}-\u{556}\u{559}\u{560}-\u{588}\u{5d0}-\u{5ea}\u{5ef}-\u{5f2}\u{620}-\u{64a}\u{660}-\u{669}\u{66e}-\u{66f}\u{671}-\u{6d3}\u{6d5}\u{6e5}-\u{6e6}\u{6ee}-\u{6fc}\u{6ff}\u{710}\u{712}-\u{72f}\u{74d}-\u{7a5}\u{7b1}\u{7c0}-\u{7ea}\u{7f4}-\u{7f5}\u{7fa}\u{800}-\u{815}\u{81a}\u{824}\u{828}\u{840}-\u{858}\u{860}-\u{86a}\u{870}-\u{887}\u{889}-\u{88e}\u{8a0}-\u{8c9}\u{904}-\u{939}\u{93d}\u{950}\u{958}-\u{961}\u{966}-\u{96f}\u{971}-\u{980}\u{985}-\u{98c}\u{98f}-\u{990}\u{993}-\u{9a8}\u{9aa}-\u{9b0}\u{9b2}\u{9b6}-\u{9b9}\u{9bd}\u{9ce}\u{9dc}-\u{9dd}\u{9df}-\u{9e1}\u{9e6}-\u{9f1}\u{9f4}-\u{9f9}\u{9fc}\u{a05}-\u{a0a}\u{a0f}-\u{a10}\u{a13}-\u{a28}\u{a2a}-\u{a30}\u{a32}-\u{a33}\u{a35}-\u{a36}\u{a38}-\u{a39}\u{a59}-\u{a5c}\u{a5e}\u{a66}-\u{a6f}\u{a72}-\u{a74}\u{a85}-\u{a8d}\u{a8f}-\u{a91}\u{a93}-\u{aa8}\u{aaa}-\u{ab0}\u{ab2}-\u{ab3}\u{ab5}-\u{ab9}\u{abd}\u{ad0}\u{ae0}-\u{ae1}\u{ae6}-\u{aef}\u{af9}\u{b05}-\u{b0c}\u{b0f}-\u{b10}\u{b13}-\u{b28}\u{b2a}-\u{b30}\u{b32}-\u{b33}\u{b35}-\u{b39}\u{b3d}\u{b5c}-\u{b5d}\u{b5f}-\u{b61}\u{b66}-\u{b6f}\u{b71}-\u{b77}\u{b83}\u{b85}-\u{b8a}\u{b8e}-\u{b90}\u{b92}-\u{b95}\u{b99}-\u{b9a}\u{b9c}\u{b9e}-\u{b9f}\u{ba3}-\u{ba4}\u{ba8}-\u{baa}\u{bae}-\u{bb9}\u{bd0}\u{be6}-\u{bf2}\u{c05}-\u{c0c}\u{c0e}-\u{c10}\u{c12}-\u{c28}\u{c2a}-\u{c39}\u{c3d}\u{c58}-\u{c5a}\u{c5d}\u{c60}-\u{c61}\u{c66}-\u{c6f}\u{c78}-\u{c7e}\u{c80}\u{c85}-\u{c8c}\u{c8e}-\u{c90}\u{c92}-\u{ca8}\u{caa}-\u{cb3}\u{cb5}-\u{cb9}\u{cbd}\u{cdd}-\u{cde}\u{ce0}-\u{ce1}\u{ce6}-\u{cef}\u{cf1}-\u{cf2}\u{d04}-\u{d0c}\u{d0e}-\u{d10}\u{d12}-\u{d3a}\u{d3d}\u{d4e}\u{d54}-\u{d56}\u{d58}-\u{d61}\u{d66}-\u{d78}\u{d7a}-\u{d7f}\u{d85}-\u{d96}\u{d9a}-\u{db1}\u{db3}-\u{dbb}\u{dbd}\u{dc0}-\u{dc6}\u{de6}-\u{def}\u{e01}-\u{e30}\u{e32}-\u{e33}\u{e40}-\u{e46}\u{e50}-\u{e59}\u{e81}-\u{e82}\u{e84}\u{e86}-\u{e8a}\u{e8c}-\u{ea3}\u{ea5}\u{ea7}-\u{eb0}\u{eb2}-\u{eb3}\u{ebd}\u{ec0}-\u{ec4}\u{ec6}\u{ed0}-\u{ed9}\u{edc}-\u{edf}\u{f00}\u{f20}-\u{f33}\u{f40}-\u{f47}\u{f49}-\u{f6c}\u{f88}-\u{f8c}\u{1000}-\u{102a}\u{103f}-\u{1049}\u{1050}-\u{1055}\u{105a}-\u{105d}\u{1061}\u{1065}-\u{1066}\u{106e}-\u{1070}\u{1075}-\u{1081}\u{108e}\u{1090}-\u{1099}\u{10a0}-\u{10c5}\u{10c7}\u{10cd}\u{10d0}-\u{10fa}\u{10fc}-\u{1248}\u{124a}-\u{124d}\u{1250}-\u{1256}\u{1258}\u{125a}-\u{125d}\u{1260}-\u{1288}\u{128a}-\u{128d}\u{1290}-\u{12b0}\u{12b2}-\u{12b5}\u{12b8}-\u{12be}\u{12c0}\u{12c2}-\u{12c5}\u{12c8}-\u{12d6}\u{12d8}-\u{1310}\u{1312}-\u{1315}\u{1318}-\u{135a}\u{1369}-\u{137c}\u{1380}-\u{138f}\u{13a0}-\u{13f5}\u{13f8}-\u{13fd}\u{1401}-\u{166c}\u{166f}-\u{167f}\u{1681}-\u{169a}\u{16a0}-\u{16ea}\u{16ee}-\u{16f8}\u{1700}-\u{1711}\u{171f}-\u{1731}\u{1740}-\u{1751}\u{1760}-\u{176c}\u{176e}-\u{1770}\u{1780}-\u{17b3}\u{17d7}\u{17dc}\u{17e0}-\u{17e9}\u{17f0}-\u{17f9}\u{1810}-\u{1819}\u{1820}-\u{1878}\u{1880}-\u{1884}\u{1887}-\u{18a8}\u{18aa}\u{18b0}-\u{18f5}\u{1900}-\u{191e}\u{1946}-\u{196d}\u{1970}-\u{1974}\u{1980}-\u{19ab}\u{19b0}-\u{19c9}\u{19d0}-\u{19da}\u{1a00}-\u{1a16}\u{1a20}-\u{1a54}\u{1a80}-\u{1a89}\u{1a90}-\u{1a99}\u{1aa7}\u{1b05}-\u{1b33}\u{1b45}-\u{1b4c}\u{1b50}-\u{1b59}\u{1b83}-\u{1ba0}\u{1bae}-\u{1be5}\u{1c00}-\u{1c23}\u{1c40}-\u{1c49}\u{1c4d}-\u{1c7d}\u{1c80}-\u{1c88}\u{1c90}-\u{1cba}\u{1cbd}-\u{1cbf}\u{1ce9}-\u{1cec}\u{1cee}-\u{1cf3}\u{1cf5}-\u{1cf6}\u{1cfa}\u{1d00}-\u{1dbf}\u{1e00}-\u{1f15}\u{1f18}-\u{1f1d}\u{1f20}-\u{1f45}\u{1f48}-\u{1f4d}\u{1f50}-\u{1f57}\u{1f59}\u{1f5b}\u{1f5d}\u{1f5f}-\u{1f7d}\u{1f80}-\u{1fb4}\u{1fb6}-\u{1fbc}\u{1fbe}\u{1fc2}-\u{1fc4}\u{1fc6}-\u{1fcc}\u{1fd0}-\u{1fd3}\u{1fd6}-\u{1fdb}\u{1fe0}-\u{1fec}\u{1ff2}-\u{1ff4}\u{1ff6}-\u{1ffc}\u{2070}-\u{2071}\u{2074}-\u{2079}\u{207f}-\u{2089}\u{2090}-\u{209c}\u{2102}\u{2107}\u{210a}-\u{2113}\u{2115}\u{2119}-\u{211d}\u{2124}\u{2126}\u{2128}\u{212a}-\u{212d}\u{212f}-\u{2139}\u{213c}-\u{213f}\u{2145}-\u{2149}\u{214e}\u{2150}-\u{2189}\u{2460}-\u{249b}\u{24ea}-\u{24ff}\u{2776}-\u{2793}\u{2c00}-\u{2ce4}\u{2ceb}-\u{2cee}\u{2cf2}-\u{2cf3}\u{2cfd}\u{2d00}-\u{2d25}\u{2d27}\u{2d2d}\u{2d30}-\u{2d67}\u{2d6f}\u{2d80}-\u{2d96}\u{2da0}-\u{2da6}\u{2da8}-\u{2dae}\u{2db0}-\u{2db6}\u{2db8}-\u{2dbe}\u{2dc0}-\u{2dc6}\u{2dc8}-\u{2dce}\u{2dd0}-\u{2dd6}\u{2dd8}-\u{2dde}\u{2e2f}\u{3005}-\u{3007}\u{3021}-\u{3029}\u{3031}-\u{3035}\u{3038}-\u{303c}\u{3041}-\u{3096}\u{309d}-\u{309f}\u{30a1}-\u{30fa}\u{30fc}-\u{30ff}\u{3105}-\u{312f}\u{3131}-\u{318e}\u{3192}-\u{3195}\u{31a0}-\u{31bf}\u{31f0}-\u{31ff}\u{3220}-\u{3229}\u{3248}-\u{324f}\u{3251}-\u{325f}\u{3280}-\u{3289}\u{32b1}-\u{32bf}\u{3400}-\u{4dbf}\u{4e00}-\u{a48c}\u{a4d0}-\u{a4fd}\u{a500}-\u{a60c}\u{a610}-\u{a62b}\u{a640}-\u{a66e}\u{a67f}-\u{a69d}\u{a6a0}-\u{a6ef}\u{a717}-\u{a71f}\u{a722}-\u{a788}\u{a78b}-\u{a7ca}\u{a7d0}-\u{a7d1}\u{a7d3}\u{a7d5}-\u{a7d9}\u{a7f2}-\u{a801}\u{a803}-\u{a805}\u{a807}-\u{a80a}\u{a80c}-\u{a822}\u{a830}-\u{a835}\u{a840}-\u{a873}\u{a882}-\u{a8b3}\u{a8d0}-\u{a8d9}\u{a8f2}-\u{a8f7}\u{a8fb}\u{a8fd}-\u{a8fe}\u{a900}-\u{a925}\u{a930}-\u{a946}\u{a960}-\u{a97c}\u{a984}-\u{a9b2}\u{a9cf}-\u{a9d9}\u{a9e0}-\u{a9e4}\u{a9e6}-\u{a9fe}\u{aa00}-\u{aa28}\u{aa40}-\u{aa42}\u{aa44}-\u{aa4b}\u{aa50}-\u{aa59}\u{aa60}-\u{aa76}\u{aa7a}\u{aa7e}-\u{aaaf}\u{aab1}\u{aab5}-\u{aab6}\u{aab9}-\u{aabd}\u{aac0}\u{aac2}\u{aadb}-\u{aadd}\u{aae0}-\u{aaea}\u{aaf2}-\u{aaf4}\u{ab01}-\u{ab06}\u{ab09}-\u{ab0e}\u{ab11}-\u{ab16}\u{ab20}-\u{ab26}\u{ab28}-\u{ab2e}\u{ab30}-\u{ab5a}\u{ab5c}-\u{ab69}\u{ab70}-\u{abe2}\u{abf0}-\u{abf9}\u{ac00}-\u{d7a3}\u{d7b0}-\u{d7c6}\u{d7cb}-\u{d7fb}\u{f900}-\u{fa6d}\u{fa70}-\u{fad9}\u{fb00}-\u{fb06}\u{fb13}-\u{fb17}\u{fb1d}\u{fb1f}-\u{fb28}\u{fb2a}-\u{fb36}\u{fb38}-\u{fb3c}\u{fb3e}\u{fb40}-\u{fb41}\u{fb43}-\u{fb44}\u{fb46}-\u{fbb1}\u{fbd3}-\u{fd3d}\u{fd50}-\u{fd8f}\u{fd92}-\u{fdc7}\u{fdf0}-\u{fdfb}\u{fe70}-\u{fe74}\u{fe76}-\u{fefc}\u{ff10}-\u{ff19}\u{ff21}-\u{ff3a}\u{ff41}-\u{ff5a}\u{ff66}-\u{ffbe}\u{ffc2}-\u{ffc7}\u{ffca}-\u{ffcf}\u{ffd2}-\u{ffd7}\u{ffda}-\u{ffdc}\u{10000}-\u{1000b}\u{1000d}-\u{10026}\u{10028}-\u{1003a}\u{1003c}-\u{1003d}\u{1003f}-\u{1004d}\u{10050}-\u{1005d}\u{10080}-\u{100fa}\u{10107}-\u{10133}\u{10140}-\u{10178}\u{1018a}-\u{1018b}\u{10280}-\u{1029c}\u{102a0}-\u{102d0}\u{102e1}-\u{102fb}\u{10300}-\u{10323}\u{1032d}-\u{1034a}\u{10350}-\u{10375}\u{10380}-\u{1039d}\u{103a0}-\u{103c3}\u{103c8}-\u{103cf}\u{103d1}-\u{103d5}\u{10400}-\u{1049d}\u{104a0}-\u{104a9}\u{104b0}-\u{104d3}\u{104d8}-\u{104fb}\u{10500}-\u{10527}\u{10530}-\u{10563}\u{10570}-\u{1057a}\u{1057c}-\u{1058a}\u{1058c}-\u{10592}\u{10594}-\u{10595}\u{10597}-\u{105a1}\u{105a3}-\u{105b1}\u{105b3}-\u{105b9}\u{105bb}-\u{105bc}\u{10600}-\u{10736}\u{10740}-\u{10755}\u{10760}-\u{10767}\u{10780}-\u{10785}\u{10787}-\u{107b0}\u{107b2}-\u{107ba}\u{10800}-\u{10805}\u{10808}\u{1080a}-\u{10835}\u{10837}-\u{10838}\u{1083c}\u{1083f}-\u{10855}\u{10858}-\u{10876}\u{10879}-\u{1089e}\u{108a7}-\u{108af}\u{108e0}-\u{108f2}\u{108f4}-\u{108f5}\u{108fb}-\u{1091b}\u{10920}-\u{10939}\u{10980}-\u{109b7}\u{109bc}-\u{109cf}\u{109d2}-\u{10a00}\u{10a10}-\u{10a13}\u{10a15}-\u{10a17}\u{10a19}-\u{10a35}\u{10a40}-\u{10a48}\u{10a60}-\u{10a7e}\u{10a80}-\u{10a9f}\u{10ac0}-\u{10ac7}\u{10ac9}-\u{10ae4}\u{10aeb}-\u{10aef}\u{10b00}-\u{10b35}\u{10b40}-\u{10b55}\u{10b58}-\u{10b72}\u{10b78}-\u{10b91}\u{10ba9}-\u{10baf}\u{10c00}-\u{10c48}\u{10c80}-\u{10cb2}\u{10cc0}-\u{10cf2}\u{10cfa}-\u{10d23}\u{10d30}-\u{10d39}\u{10e60}-\u{10e7e}\u{10e80}-\u{10ea9}\u{10eb0}-\u{10eb1}\u{10f00}-\u{10f27}\u{10f30}-\u{10f45}\u{10f51}-\u{10f54}\u{10f70}-\u{10f81}\u{10fb0}-\u{10fcb}\u{10fe0}-\u{10ff6}\u{11003}-\u{11037}\u{11052}-\u{1106f}\u{11071}-\u{11072}\u{11075}\u{11083}-\u{110af}\u{110d0}-\u{110e8}\u{110f0}-\u{110f9}\u{11103}-\u{11126}\u{11136}-\u{1113f}\u{11144}\u{11147}\u{11150}-\u{11172}\u{11176}\u{11183}-\u{111b2}\u{111c1}-\u{111c4}\u{111d0}-\u{111da}\u{111dc}\u{111e1}-\u{111f4}\u{11200}-\u{11211}\u{11213}-\u{1122b}\u{1123f}-\u{11240}\u{11280}-\u{11286}\u{11288}\u{1128a}-\u{1128d}\u{1128f}-\u{1129d}\u{1129f}-\u{112a8}\u{112b0}-\u{112de}\u{112f0}-\u{112f9}\u{11305}-\u{1130c}\u{1130f}-\u{11310}\u{11313}-\u{11328}\u{1132a}-\u{11330}\u{11332}-\u{11333}\u{11335}-\u{11339}\u{1133d}\u{11350}\u{1135d}-\u{11361}\u{11400}-\u{11434}\u{11447}-\u{1144a}\u{11450}-\u{11459}\u{1145f}-\u{11461}\u{11480}-\u{114af}\u{114c4}-\u{114c5}\u{114c7}\u{114d0}-\u{114d9}\u{11580}-\u{115ae}\u{115d8}-\u{115db}\u{11600}-\u{1162f}\u{11644}\u{11650}-\u{11659}\u{11680}-\u{116aa}\u{116b8}\u{116c0}-\u{116c9}\u{11700}-\u{1171a}\u{11730}-\u{1173b}\u{11740}-\u{11746}\u{11800}-\u{1182b}\u{118a0}-\u{118f2}\u{118ff}-\u{11906}\u{11909}\u{1190c}-\u{11913}\u{11915}-\u{11916}\u{11918}-\u{1192f}\u{1193f}\u{11941}\u{11950}-\u{11959}\u{119a0}-\u{119a7}\u{119aa}-\u{119d0}\u{119e1}\u{119e3}\u{11a00}\u{11a0b}-\u{11a32}\u{11a3a}\u{11a50}\u{11a5c}-\u{11a89}\u{11a9d}\u{11ab0}-\u{11af8}\u{11c00}-\u{11c08}\u{11c0a}-\u{11c2e}\u{11c40}\u{11c50}-\u{11c6c}\u{11c72}-\u{11c8f}\u{11d00}-\u{11d06}\u{11d08}-\u{11d09}\u{11d0b}-\u{11d30}\u{11d46}\u{11d50}-\u{11d59}\u{11d60}-\u{11d65}\u{11d67}-\u{11d68}\u{11d6a}-\u{11d89}\u{11d98}\u{11da0}-\u{11da9}\u{11ee0}-\u{11ef2}\u{11f02}\u{11f04}-\u{11f10}\u{11f12}-\u{11f33}\u{11f50}-\u{11f59}\u{11fb0}\u{11fc0}-\u{11fd4}\u{12000}-\u{12399}\u{12400}-\u{1246e}\u{12480}-\u{12543}\u{12f90}-\u{12ff0}\u{13000}-\u{1342f}\u{13441}-\u{13446}\u{14400}-\u{14646}\u{16800}-\u{16a38}\u{16a40}-\u{16a5e}\u{16a60}-\u{16a69}\u{16a70}-\u{16abe}\u{16ac0}-\u{16ac9}\u{16ad0}-\u{16aed}\u{16b00}-\u{16b2f}\u{16b40}-\u{16b43}\u{16b50}-\u{16b59}\u{16b5b}-\u{16b61}\u{16b63}-\u{16b77}\u{16b7d}-\u{16b8f}\u{16e40}-\u{16e96}\u{16f00}-\u{16f4a}\u{16f50}\u{16f93}-\u{16f9f}\u{16fe0}-\u{16fe1}\u{16fe3}\u{17000}-\u{187f7}\u{18800}-\u{18cd5}\u{18d00}-\u{18d08}\u{1aff0}-\u{1aff3}\u{1aff5}-\u{1affb}\u{1affd}-\u{1affe}\u{1b000}-\u{1b122}\u{1b132}\u{1b150}-\u{1b152}\u{1b155}\u{1b164}-\u{1b167}\u{1b170}-\u{1b2fb}\u{1bc00}-\u{1bc6a}\u{1bc70}-\u{1bc7c}\u{1bc80}-\u{1bc88}\u{1bc90}-\u{1bc99}\u{1d2c0}-\u{1d2d3}\u{1d2e0}-\u{1d2f3}\u{1d360}-\u{1d378}\u{1d400}-\u{1d454}\u{1d456}-\u{1d49c}\u{1d49e}-\u{1d49f}\u{1d4a2}\u{1d4a5}-\u{1d4a6}\u{1d4a9}-\u{1d4ac}\u{1d4ae}-\u{1d4b9}\u{1d4bb}\u{1d4bd}-\u{1d4c3}\u{1d4c5}-\u{1d505}\u{1d507}-\u{1d50a}\u{1d50d}-\u{1d514}\u{1d516}-\u{1d51c}\u{1d51e}-\u{1d539}\u{1d53b}-\u{1d53e}\u{1d540}-\u{1d544}\u{1d546}\u{1d54a}-\u{1d550}\u{1d552}-\u{1d6a5}\u{1d6a8}-\u{1d6c0}\u{1d6c2}-\u{1d6da}\u{1d6dc}-\u{1d6fa}\u{1d6fc}-\u{1d714}\u{1d716}-\u{1d734}\u{1d736}-\u{1d74e}\u{1d750}-\u{1d76e}\u{1d770}-\u{1d788}\u{1d78a}-\u{1d7a8}\u{1d7aa}-\u{1d7c2}\u{1d7c4}-\u{1d7cb}\u{1d7ce}-\u{1d7ff}\u{1df00}-\u{1df1e}\u{1df25}-\u{1df2a}\u{1e030}-\u{1e06d}\u{1e100}-\u{1e12c}\u{1e137}-\u{1e13d}\u{1e140}-\u{1e149}\u{1e14e}\u{1e290}-\u{1e2ad}\u{1e2c0}-\u{1e2eb}\u{1e2f0}-\u{1e2f9}\u{1e4d0}-\u{1e4eb}\u{1e4f0}-\u{1e4f9}\u{1e7e0}-\u{1e7e6}\u{1e7e8}-\u{1e7eb}\u{1e7ed}-\u{1e7ee}\u{1e7f0}-\u{1e7fe}\u{1e800}-\u{1e8c4}\u{1e8c7}-\u{1e8cf}\u{1e900}-\u{1e943}\u{1e94b}\u{1e950}-\u{1e959}\u{1ec71}-\u{1ecab}\u{1ecad}-\u{1ecaf}\u{1ecb1}-\u{1ecb4}\u{1ed01}-\u{1ed2d}\u{1ed2f}-\u{1ed3d}\u{1ee00}-\u{1ee03}\u{1ee05}-\u{1ee1f}\u{1ee21}-\u{1ee22}\u{1ee24}\u{1ee27}\u{1ee29}-\u{1ee32}\u{1ee34}-\u{1ee37}\u{1ee39}\u{1ee3b}\u{1ee42}\u{1ee47}\u{1ee49}\u{1ee4b}\u{1ee4d}-\u{1ee4f}\u{1ee51}-\u{1ee52}\u{1ee54}\u{1ee57}\u{1ee59}\u{1ee5b}\u{1ee5d}\u{1ee5f}\u{1ee61}-\u{1ee62}\u{1ee64}\u{1ee67}-\u{1ee6a}\u{1ee6c}-\u{1ee72}\u{1ee74}-\u{1ee77}\u{1ee79}-\u{1ee7c}\u{1ee7e}\u{1ee80}-\u{1ee89}\u{1ee8b}-\u{1ee9b}\u{1eea1}-\u{1eea3}\u{1eea5}-\u{1eea9}\u{1eeab}-\u{1eebb}\u{1f100}-\u{1f10c}\u{1fbf0}-\u{1fbf9}\u{20000}-\u{2a6df}\u{2a700}-\u{2b739}\u{2b740}-\u{2b81d}\u{2b820}-\u{2cea1}\u{2ceb0}-\u{2ebe0}\u{2ebf0}-\u{2ee5d}\u{2f800}-\u{2fa1d}\u{30000}-\u{3134a}\u{31350}-\u{323af}]/u;
// Unicode 15.1 GraphemeBreakProperty.txt Extend + SpacingMark, merged ranges.
const EXTEND_OR_SPACING_MARK =
  // eslint-disable-next-line no-misleading-character-class -- these are property ranges, not text
  /[\u{300}-\u{36f}\u{483}-\u{489}\u{591}-\u{5bd}\u{5bf}\u{5c1}-\u{5c2}\u{5c4}-\u{5c5}\u{5c7}\u{610}-\u{61a}\u{64b}-\u{65f}\u{670}\u{6d6}-\u{6dc}\u{6df}-\u{6e4}\u{6e7}-\u{6e8}\u{6ea}-\u{6ed}\u{711}\u{730}-\u{74a}\u{7a6}-\u{7b0}\u{7eb}-\u{7f3}\u{7fd}\u{816}-\u{819}\u{81b}-\u{823}\u{825}-\u{827}\u{829}-\u{82d}\u{859}-\u{85b}\u{898}-\u{89f}\u{8ca}-\u{8e1}\u{8e3}-\u{903}\u{93a}-\u{93c}\u{93e}-\u{94f}\u{951}-\u{957}\u{962}-\u{963}\u{981}-\u{983}\u{9bc}\u{9be}-\u{9c4}\u{9c7}-\u{9c8}\u{9cb}-\u{9cd}\u{9d7}\u{9e2}-\u{9e3}\u{9fe}\u{a01}-\u{a03}\u{a3c}\u{a3e}-\u{a42}\u{a47}-\u{a48}\u{a4b}-\u{a4d}\u{a51}\u{a70}-\u{a71}\u{a75}\u{a81}-\u{a83}\u{abc}\u{abe}-\u{ac5}\u{ac7}-\u{ac9}\u{acb}-\u{acd}\u{ae2}-\u{ae3}\u{afa}-\u{aff}\u{b01}-\u{b03}\u{b3c}\u{b3e}-\u{b44}\u{b47}-\u{b48}\u{b4b}-\u{b4d}\u{b55}-\u{b57}\u{b62}-\u{b63}\u{b82}\u{bbe}-\u{bc2}\u{bc6}-\u{bc8}\u{bca}-\u{bcd}\u{bd7}\u{c00}-\u{c04}\u{c3c}\u{c3e}-\u{c44}\u{c46}-\u{c48}\u{c4a}-\u{c4d}\u{c55}-\u{c56}\u{c62}-\u{c63}\u{c81}-\u{c83}\u{cbc}\u{cbe}-\u{cc4}\u{cc6}-\u{cc8}\u{cca}-\u{ccd}\u{cd5}-\u{cd6}\u{ce2}-\u{ce3}\u{cf3}\u{d00}-\u{d03}\u{d3b}-\u{d3c}\u{d3e}-\u{d44}\u{d46}-\u{d48}\u{d4a}-\u{d4d}\u{d57}\u{d62}-\u{d63}\u{d81}-\u{d83}\u{dca}\u{dcf}-\u{dd4}\u{dd6}\u{dd8}-\u{ddf}\u{df2}-\u{df3}\u{e31}\u{e33}-\u{e3a}\u{e47}-\u{e4e}\u{eb1}\u{eb3}-\u{ebc}\u{ec8}-\u{ece}\u{f18}-\u{f19}\u{f35}\u{f37}\u{f39}\u{f3e}-\u{f3f}\u{f71}-\u{f84}\u{f86}-\u{f87}\u{f8d}-\u{f97}\u{f99}-\u{fbc}\u{fc6}\u{102d}-\u{1037}\u{1039}-\u{103e}\u{1056}-\u{1059}\u{105e}-\u{1060}\u{1071}-\u{1074}\u{1082}\u{1084}-\u{1086}\u{108d}\u{109d}\u{135d}-\u{135f}\u{1712}-\u{1715}\u{1732}-\u{1734}\u{1752}-\u{1753}\u{1772}-\u{1773}\u{17b4}-\u{17d3}\u{17dd}\u{180b}-\u{180d}\u{180f}\u{1885}-\u{1886}\u{18a9}\u{1920}-\u{192b}\u{1930}-\u{193b}\u{1a17}-\u{1a1b}\u{1a55}-\u{1a5e}\u{1a60}\u{1a62}\u{1a65}-\u{1a7c}\u{1a7f}\u{1ab0}-\u{1ace}\u{1b00}-\u{1b04}\u{1b34}-\u{1b44}\u{1b6b}-\u{1b73}\u{1b80}-\u{1b82}\u{1ba1}-\u{1bad}\u{1be6}-\u{1bf3}\u{1c24}-\u{1c37}\u{1cd0}-\u{1cd2}\u{1cd4}-\u{1ce8}\u{1ced}\u{1cf4}\u{1cf7}-\u{1cf9}\u{1dc0}-\u{1dff}\u{200c}\u{20d0}-\u{20f0}\u{2cef}-\u{2cf1}\u{2d7f}\u{2de0}-\u{2dff}\u{302a}-\u{302f}\u{3099}-\u{309a}\u{a66f}-\u{a672}\u{a674}-\u{a67d}\u{a69e}-\u{a69f}\u{a6f0}-\u{a6f1}\u{a802}\u{a806}\u{a80b}\u{a823}-\u{a827}\u{a82c}\u{a880}-\u{a881}\u{a8b4}-\u{a8c5}\u{a8e0}-\u{a8f1}\u{a8ff}\u{a926}-\u{a92d}\u{a947}-\u{a953}\u{a980}-\u{a983}\u{a9b3}-\u{a9c0}\u{a9e5}\u{aa29}-\u{aa36}\u{aa43}\u{aa4c}-\u{aa4d}\u{aa7c}\u{aab0}\u{aab2}-\u{aab4}\u{aab7}-\u{aab8}\u{aabe}-\u{aabf}\u{aac1}\u{aaeb}-\u{aaef}\u{aaf5}-\u{aaf6}\u{abe3}-\u{abea}\u{abec}-\u{abed}\u{fb1e}\u{fe00}-\u{fe0f}\u{fe20}-\u{fe2f}\u{ff9e}-\u{ff9f}\u{101fd}\u{102e0}\u{10376}-\u{1037a}\u{10a01}-\u{10a03}\u{10a05}-\u{10a06}\u{10a0c}-\u{10a0f}\u{10a38}-\u{10a3a}\u{10a3f}\u{10ae5}-\u{10ae6}\u{10d24}-\u{10d27}\u{10eab}-\u{10eac}\u{10efd}-\u{10eff}\u{10f46}-\u{10f50}\u{10f82}-\u{10f85}\u{11000}-\u{11002}\u{11038}-\u{11046}\u{11070}\u{11073}-\u{11074}\u{1107f}-\u{11082}\u{110b0}-\u{110ba}\u{110c2}\u{11100}-\u{11102}\u{11127}-\u{11134}\u{11145}-\u{11146}\u{11173}\u{11180}-\u{11182}\u{111b3}-\u{111c0}\u{111c9}-\u{111cc}\u{111ce}-\u{111cf}\u{1122c}-\u{11237}\u{1123e}\u{11241}\u{112df}-\u{112ea}\u{11300}-\u{11303}\u{1133b}-\u{1133c}\u{1133e}-\u{11344}\u{11347}-\u{11348}\u{1134b}-\u{1134d}\u{11357}\u{11362}-\u{11363}\u{11366}-\u{1136c}\u{11370}-\u{11374}\u{11435}-\u{11446}\u{1145e}\u{114b0}-\u{114c3}\u{115af}-\u{115b5}\u{115b8}-\u{115c0}\u{115dc}-\u{115dd}\u{11630}-\u{11640}\u{116ab}-\u{116b7}\u{1171d}-\u{1171f}\u{11722}-\u{1172b}\u{1182c}-\u{1183a}\u{11930}-\u{11935}\u{11937}-\u{11938}\u{1193b}-\u{1193e}\u{11940}\u{11942}-\u{11943}\u{119d1}-\u{119d7}\u{119da}-\u{119e0}\u{119e4}\u{11a01}-\u{11a0a}\u{11a33}-\u{11a39}\u{11a3b}-\u{11a3e}\u{11a47}\u{11a51}-\u{11a5b}\u{11a8a}-\u{11a99}\u{11c2f}-\u{11c36}\u{11c38}-\u{11c3f}\u{11c92}-\u{11ca7}\u{11ca9}-\u{11cb6}\u{11d31}-\u{11d36}\u{11d3a}\u{11d3c}-\u{11d3d}\u{11d3f}-\u{11d45}\u{11d47}\u{11d8a}-\u{11d8e}\u{11d90}-\u{11d91}\u{11d93}-\u{11d97}\u{11ef3}-\u{11ef6}\u{11f00}-\u{11f01}\u{11f03}\u{11f34}-\u{11f3a}\u{11f3e}-\u{11f42}\u{13440}\u{13447}-\u{13455}\u{16af0}-\u{16af4}\u{16b30}-\u{16b36}\u{16f4f}\u{16f51}-\u{16f87}\u{16f8f}-\u{16f92}\u{16fe4}\u{16ff0}-\u{16ff1}\u{1bc9d}-\u{1bc9e}\u{1cf00}-\u{1cf2d}\u{1cf30}-\u{1cf46}\u{1d165}-\u{1d169}\u{1d16d}-\u{1d172}\u{1d17b}-\u{1d182}\u{1d185}-\u{1d18b}\u{1d1aa}-\u{1d1ad}\u{1d242}-\u{1d244}\u{1da00}-\u{1da36}\u{1da3b}-\u{1da6c}\u{1da75}\u{1da84}\u{1da9b}-\u{1da9f}\u{1daa1}-\u{1daaf}\u{1e000}-\u{1e006}\u{1e008}-\u{1e018}\u{1e01b}-\u{1e021}\u{1e023}-\u{1e024}\u{1e026}-\u{1e02a}\u{1e08f}\u{1e130}-\u{1e136}\u{1e2ae}\u{1e2ec}-\u{1e2ef}\u{1e4ec}-\u{1e4ef}\u{1e8d0}-\u{1e8d6}\u{1e944}-\u{1e94a}\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
// Unicode 15.1 emoji-data.txt, merged into deterministic ranges.
const EXTENDED_PICTOGRAPHIC =
  /[\u{a9}\u{ae}\u{203c}\u{2049}\u{2122}\u{2139}\u{2194}-\u{2199}\u{21a9}-\u{21aa}\u{231a}-\u{231b}\u{2328}\u{2388}\u{23cf}\u{23e9}-\u{23f3}\u{23f8}-\u{23fa}\u{24c2}\u{25aa}-\u{25ab}\u{25b6}\u{25c0}\u{25fb}-\u{25fe}\u{2600}-\u{2605}\u{2607}-\u{2612}\u{2614}-\u{2685}\u{2690}-\u{2705}\u{2708}-\u{2712}\u{2714}\u{2716}\u{271d}\u{2721}\u{2728}\u{2733}-\u{2734}\u{2744}\u{2747}\u{274c}\u{274e}\u{2753}-\u{2755}\u{2757}\u{2763}-\u{2767}\u{2795}-\u{2797}\u{27a1}\u{27b0}\u{27bf}\u{2934}-\u{2935}\u{2b05}-\u{2b07}\u{2b1b}-\u{2b1c}\u{2b50}\u{2b55}\u{3030}\u{303d}\u{3297}\u{3299}\u{1f000}-\u{1f0ff}\u{1f10d}-\u{1f10f}\u{1f12f}\u{1f16c}-\u{1f171}\u{1f17e}-\u{1f17f}\u{1f18e}\u{1f191}-\u{1f19a}\u{1f1ad}-\u{1f1e5}\u{1f201}-\u{1f20f}\u{1f21a}\u{1f22f}\u{1f232}-\u{1f23a}\u{1f23c}-\u{1f23f}\u{1f249}-\u{1f3fa}\u{1f400}-\u{1f53d}\u{1f546}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f774}-\u{1f77f}\u{1f7d5}-\u{1f7ff}\u{1f80c}-\u{1f80f}\u{1f848}-\u{1f84f}\u{1f85a}-\u{1f85f}\u{1f888}-\u{1f88f}\u{1f8ae}-\u{1f8ff}\u{1f90c}-\u{1f93a}\u{1f93c}-\u{1f945}\u{1f947}-\u{1faff}\u{1fc00}-\u{1fffd}]/u;
const PREPEND =
  /[\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u0d4e\u{110bd}\u{110cd}\u{111c2}-\u{111c3}\u{1193f}\u{11941}\u{11a3a}\u{11a84}-\u{11a89}\u{11d46}\u{11f02}]/u;
const CONNECTOR =
  /^[\u{5f}\u{203f}-\u{2040}\u{2054}\u{fe33}-\u{fe34}\u{fe4d}-\u{fe4f}\u{ff3f}'’ʼ]$/u;
const WHITESPACE = /^\s+$/u;
const INDIC_LINKERS = new Set([0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d]);
const INDIC_CONSONANTS = [
  [0x0915, 0x0939],
  [0x0958, 0x095f],
  [0x0978, 0x097f],
  [0x0995, 0x09a8],
  [0x09aa, 0x09b0],
  [0x09b2, 0x09b2],
  [0x09b6, 0x09b9],
  [0x09dc, 0x09dd],
  [0x09df, 0x09df],
  [0x09f0, 0x09f1],
  [0x0a95, 0x0aa8],
  [0x0aaa, 0x0ab0],
  [0x0ab2, 0x0ab3],
  [0x0ab5, 0x0ab9],
  [0x0af9, 0x0af9],
  [0x0b15, 0x0b28],
  [0x0b2a, 0x0b30],
  [0x0b32, 0x0b33],
  [0x0b35, 0x0b39],
  [0x0b5c, 0x0b5d],
  [0x0b5f, 0x0b5f],
  [0x0b71, 0x0b71],
  [0x0c15, 0x0c28],
  [0x0c2a, 0x0c39],
  [0x0c58, 0x0c5a],
  [0x0d15, 0x0d3a],
] as const;

export function tokenizeText(text: string): readonly TextUnit[] {
  const graphemes = scanGraphemes(text);
  const units: TextUnit[] = [];
  for (let index = 0; index < graphemes.length; ) {
    const grapheme = graphemes[index]!;
    if (WHITESPACE.test(grapheme.text)) {
      index++;
      continue;
    }
    if (!isWord(grapheme.text)) {
      units.push({ ...grapheme, kind: "punctuation" });
      index++;
      continue;
    }
    const start = grapheme.start;
    let end = grapheme.end;
    index++;
    while (index < graphemes.length) {
      const current = graphemes[index]!;
      if (isWord(current.text)) {
        end = current.end;
        index++;
        continue;
      }
      if (
        CONNECTOR.test(current.text) &&
        isWord(graphemes[index + 1]?.text ?? "")
      ) {
        end = graphemes[index + 1]!.end;
        index += 2;
        continue;
      }
      break;
    }
    units.push({ kind: "word", start, end, text: text.slice(start, end) });
  }
  return units;
}

export function graphemeBoundaries(text: string): readonly number[] {
  const scanned = scanGraphemes(text);
  return [0, ...scanned.map(({ end }) => end)];
}

function scanGraphemes(text: string): readonly Grapheme[] {
  let offset = 0;
  const points = [...text].map((value) => {
    const point = { value, start: offset };
    offset += value.length;
    return point;
  });
  const result: Grapheme[] = [];
  for (let index = 0; index < points.length; ) {
    const start = points[index]!.start;
    let first = points[index]!.value.codePointAt(0)!;
    index++;
    if (first === 0x0d && codePoint(points[index]) === 0x0a) index++;
    else if (!isControl(first)) {
      while (
        isPrepend(first) &&
        points[index] &&
        !isControl(codePoint(points[index]))
      ) {
        first = codePoint(points[index]);
        index++;
      }
      if (
        isRegionalIndicator(first) &&
        isRegionalIndicator(codePoint(points[index]))
      )
        index++;
      else
        while (
          joinsHangul(codePoint(points[index - 1]), codePoint(points[index]))
        )
          index++;
      let indicLinker = false;
      let emojiSequence = EXTENDED_PICTOGRAPHIC.test(points[index - 1]!.value);
      for (;;) {
        while (points[index] && isExtension(points[index]!.value)) {
          indicLinker ||= INDIC_LINKERS.has(codePoint(points[index]));
          index++;
        }
        if (codePoint(points[index]) === 0x200d) {
          index++;
          if (
            emojiSequence &&
            EXTENDED_PICTOGRAPHIC.test(points[index]?.value ?? "")
          ) {
            index++;
            continue;
          }
          emojiSequence = false;
          continue;
        }
        if (
          isIndicConsonant(first) &&
          indicLinker &&
          isIndicConsonant(codePoint(points[index]))
        ) {
          indicLinker = false;
          index++;
          continue;
        }
        break;
      }
    }
    const end = points[index]?.start ?? text.length;
    result.push({ start, end, text: text.slice(start, end) });
  }
  return result;
}

function isWord(value: string): boolean {
  return WORD.test(value) && !value.includes("\u20e3");
}

function isExtension(value: string): boolean {
  return EXTEND_OR_SPACING_MARK.test(value);
}

function codePoint(value: Readonly<{ value: string }> | undefined): number {
  return value?.value.codePointAt(0) ?? -1;
}

function isRegionalIndicator(point: number): boolean {
  return point >= 0x1f1e6 && point <= 0x1f1ff;
}

function isControl(point: number): boolean {
  return (
    (point >= 0x0000 && point <= 0x0009) ||
    point === 0x000a ||
    (point >= 0x000b && point <= 0x000c) ||
    point === 0x000d ||
    (point >= 0x000e && point <= 0x001f) ||
    (point >= 0x007f && point <= 0x009f) ||
    point === 0x00ad ||
    point === 0x061c ||
    point === 0x180e ||
    point === 0x200b ||
    (point >= 0x200e && point <= 0x200f) ||
    (point >= 0x2028 && point <= 0x202e) ||
    (point >= 0x2060 && point <= 0x206f) ||
    point === 0xfeff ||
    (point >= 0xfff0 && point <= 0xfffb) ||
    (point >= 0x13430 && point <= 0x1343f) ||
    (point >= 0x1bca0 && point <= 0x1bca3) ||
    (point >= 0x1d173 && point <= 0x1d17a) ||
    (point >= 0xe0000 && point <= 0xe001f) ||
    (point >= 0xe0080 && point <= 0xe00ff) ||
    (point >= 0xe01f0 && point <= 0xe0fff)
  );
}

function isPrepend(point: number): boolean {
  return PREPEND.test(String.fromCodePoint(point));
}

function joinsHangul(left: number, right: number): boolean {
  const before = hangulType(left);
  const after = hangulType(right);
  return (
    (before === "L" && ["L", "V", "LV", "LVT"].includes(after)) ||
    (["LV", "V"].includes(before) && ["V", "T"].includes(after)) ||
    (["LVT", "T"].includes(before) && after === "T")
  );
}

function hangulType(point: number): "L" | "V" | "T" | "LV" | "LVT" | "" {
  if (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0xa960 && point <= 0xa97c)
  )
    return "L";
  if (
    (point >= 0x1160 && point <= 0x11a7) ||
    (point >= 0xd7b0 && point <= 0xd7c6)
  )
    return "V";
  if (
    (point >= 0x11a8 && point <= 0x11ff) ||
    (point >= 0xd7cb && point <= 0xd7fb)
  )
    return "T";
  if (point < 0xac00 || point > 0xd7a3) return "";
  return (point - 0xac00) % 28 === 0 ? "LV" : "LVT";
}

function isIndicConsonant(point: number): boolean {
  return INDIC_CONSONANTS.some(
    ([start, end]) => point >= start && point <= end,
  );
}
