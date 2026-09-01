plugins {
    id("com.android.application")
}

android {
    namespace = "com.code2hack.glasseo"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.code2hack.glasseo"
        minSdk = 32
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    sourceSets.getByName("main").assets.srcDir("build/generated/web")
}

val buildWeb by tasks.registering(Exec::class) {
    workingDir(rootDir)
    commandLine("npm", "run", "build")
    inputs.files(
        fileTree(rootDir.resolve("web")),
        rootDir.resolve("scripts/build-web.mjs"),
        rootDir.resolve("package.json"),
        rootDir.resolve("package-lock.json"),
        rootDir.resolve("tsconfig.json"),
    )
    outputs.dir(layout.buildDirectory.dir("generated/web"))
}

tasks.configureEach {
    if ((name.startsWith("merge") && name.endsWith("Assets")) || name.contains("lint", ignoreCase = true)) {
        dependsOn(buildWeb)
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.17.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")

    androidTestImplementation("androidx.test:core-ktx:1.7.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit-ktx:1.3.0")
}
