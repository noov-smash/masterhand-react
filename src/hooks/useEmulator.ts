import React from "react";
// Hooks
import { Context } from "./Provider";
import { useDatabase } from "./useDatabase";
import { useGamePad } from "./useGamePad";
// Configs
import { SwitchControlLibrary } from "../configs/controller";
// Interfaces
import { ContextProps, SignalProps } from "../interfaces";
import uid from "uniqid";
import rison from "rison";
import { BitlyClient } from "bitly";
const bitly = new BitlyClient(process.env.REACT_APP_BITLY_TOKEN || "");

export const useEmulator = () => {
  const [context, setContext] = React.useContext(Context);
  const [buffer, setBuffer] = React.useState<SignalProps[]>();
  const intervalRef = React.useRef<NodeJS.Timeout | null>();
  const { saveCommand, storeCommand, saveFile } = useDatabase();
  const { onPush, onTilt, neutral } = useGamePad();

  const bufferRef = React.useRef(buffer);
  React.useEffect(() => {
    bufferRef.current = buffer;
  }, [buffer]);

  const recorderStart = React.useCallback((): void => {
    if (!context.media.recorder || context.media.recorder.state === "recording")
      return;
    console.log("Screen Rec...");
    context.media.recorder.ondataavailable = (e: any) => {
      const blob = new Blob([e.data], { type: e.data.type });
      setContext((c: ContextProps) => ({
        ...c,
        emulator: {
          ...c.emulator,
          command: {
            ...c.emulator.command,
            blob: blob,
          },
        },
      }));
    };
    context.media.recorder.start();
  }, [context.media.recorder, setContext]);

  const recorderStop = React.useCallback((): void => {
    if (!context.media.recorder || context.media.recorder.state !== "recording")
      return;
    console.log("Screen Stop...");
    context.media.recorder.stop();
  }, [context.media.recorder]);

  const stopRec = React.useCallback(async (): Promise<void> => {
    console.log("Stop Rec...");
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    recorderStop();
    setContext((c: ContextProps) => ({
      ...c,
      emulator: {
        ...c.emulator,
        state: "standby",
        command: {
          ...c.emulator.command,
          signals: c.emulator.command.signals?.concat([
            {
              t: Number(c.emulator.time.toFixed(2)),
              s: new Uint8Array([99, 0]),
            },
          ]),
        },
      },
    }));
    neutral();
  }, [neutral, recorderStop, setContext]);

  const stopPlay = React.useCallback(
    async (reset?: boolean): Promise<void> => {
      if (intervalRef.current) {
        console.log("Stop Play...");
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      neutral();
      setContext((c: ContextProps) => ({
        ...c,
        emulator: reset
          ? { ...c.emulator, state: "standby", time: 0 }
          : { ...c.emulator, state: "standby" },
      }));
    },
    [neutral, setContext]
  );

  const recInterval = React.useCallback((): void => {
    setContext((c: ContextProps) => ({
      ...c,
      emulator: {
        ...c.emulator,
        time: Number((c.emulator.time + 1 / 60).toFixed(2)),
      },
    }));
  }, [setContext]);

  const isTimeOver = React.useCallback(
    (time: number) => {
      const lastCommand =
        context.emulator.command.signals[
          context.emulator.command.signals.length - 1
        ];
      return lastCommand.t <= time;
    },
    [context.emulator.command.signals]
  );

  const playInterval = React.useCallback(async (): Promise<void> => {
    setContext((c: ContextProps) => {
      if (!bufferRef.current) return { ...c };
      const time = Number((c.emulator.time + 1 / 60).toFixed(2));
      const data = bufferRef.current.filter((b) => b.t === time);
      if (!data) return { ...c };
      Promise.all(
        data.map((d) => {
          if (d.s[0] <= 17) return onPush(d.s[0], d.s[1] === 1 ? true : false);
          else if (18 <= d.s[0] && d.s[0] <= 21) return onTilt(d.s[0], d.s[1]);
          return null;
        })
      );

      // If it over record time, stop timer
      if (isTimeOver(time)) {
        if (c.emulator.state === "playing") stopPlay(true);
        else if (c.emulator.state === "repeating") {
          setBuffer(context.emulator.command.signals);
          return {
            ...c,
            emulator: { ...c.emulator, state: "repeating", time: 0 },
          };
        }
      }
      return {
        ...c,
        emulator: {
          ...c.emulator,
          time: time,
        },
      };
    });
  }, [
    context.emulator.command.signals,
    isTimeOver,
    onPush,
    onTilt,
    setContext,
    stopPlay,
  ]);

  const rec = React.useCallback(async (): Promise<void> => {
    console.log("Rec...");
    if (context.emulator.command.signals.length > 0) {
      const res = window.confirm(
        "既存のコマンドを破棄して新記録画を開始しますか？\nDiscard an existing command and start a new recording ?\n"
      );
      if (!res) return;
    }
    recorderStart();
    setContext((c: ContextProps) => ({
      ...c,
      emulator: {
        ...c.emulator,
        state: "recording",
        time: 0,
        command: {
          ...c.emulator.command,
          signals: [],
        },
      },
    }));
    intervalRef.current = setInterval(recInterval, 1000 / 60);
  }, [
    context.emulator.command.signals.length,
    recInterval,
    recorderStart,
    setContext,
  ]);

  const play = React.useCallback(
    async (repeat: boolean): Promise<void> => {
      console.log(repeat ? "Repeat..." : "Play...");
      setContext((c: ContextProps) => ({
        ...c,
        emulator: {
          ...c.emulator,
          state: repeat ? "repeating" : "playing",
          time: 0,
        },
      }));
      setBuffer(context.emulator.command.signals);
      intervalRef.current = setInterval(playInterval, 1000 / 60);
    },
    [context.emulator.command.signals, playInterval, setContext]
  );

  const save = React.useCallback(async (): Promise<void> => {
    if (!context.emulator.command.signals) return;
    console.log("Saving...", context.emulator.command.signals);
    try {
      // Upload Webm
      const data = context.emulator.command;
      if (data.blob)
        data.videoUrl = await saveFile(`files/${data.id}.webm`, data.blob);
      else delete data.videoUrl;
      // AminUser
      if (context.user.isAdmin && context.emulator.saveTo === "db") {
        // Exist
        if (data.path) {
          await saveCommand(`${context.project.id}/${data.path}`, {
            id: data.id,
            title: data.title,
            path: data.path,
            data: data,
          });
          window.alert(
            `"${data.title}" を上書きしました。\nUpdated "${data.title}."`
          );
        } else {
          // New
          const path = `${context.project.id}/${context.project.publicData?.length}`;
          await saveCommand(path, {
            id: uid(),
            index: {
              title: "Untitled",
            },
            items: [
              {
                id: uid(),
                title: "Untitled",
                data: data,
              },
            ],
          });
          window.alert(
            `新規コマンド"Untitled"として保存しました。\nSaved as  a new command "Untitled".`
          );
        }
      }
      // AnonymousUser or Local Storage
      else {
        if (!context.project.id) return;
        if (!context.project.privateData) return;
        const path: string[] = data.path.split("/");
        const newData: any = Array.from(context.project.privateData);
        if (path.length === 1 || !newData) {
          const id1 = uid();
          const id2 = uid();
          newData.splice(newData.length, 0, {
            id: id1,
            index: { title: "Untitled", id: uid() },
            items: [
              { id: id2, path: `0/${id1}/0`, title: "Untitled", data: data },
            ],
          });
        } else if (path.length === 3)
          newData[path[0]][path[1]][path[2]].data = data;
        else if (path.length === 5)
          newData[path[0]][path[1]][path[2]][path[3]][path[4]].data = data;
        else window.alert("保存に失敗しました\n Failed to save.");
        await storeCommand(context.project.id, newData);
        if (data.path)
          window.alert(
            `"${data.title}" を上書きしました。\nUpdated "${data.title}."`
          );
        else
          window.alert(
            `新規コマンド"Untitled"として保存しました。\nSaved as  a new command "Untitled".`
          );
      }
    } catch (error) {
      window.alert("保存に失敗しました\n Failed to save.");
      console.error(error);
    }
  }, [
    context.emulator.command,
    context.emulator.saveTo,
    context.project.id,
    context.project.privateData,
    context.project.publicData?.length,
    context.user.isAdmin,
    saveCommand,
    saveFile,
    storeCommand,
  ]);

  const download = React.useCallback(async (): Promise<void> => {
    try {
      if (!context.project.privateData) return;
      const data = context.emulator.command;
      const newData: any = Array.from(context.project.privateData);
      const id1 = uid();
      const id2 = uid();
      newData.splice(newData.length, 0, {
        id: id1,
        index: { title: "Downloaded", id: uid() },
        items: [
          {
            id: id2,
            path: `0/${id1}/0`,
            title: data.title || "Untitled",
            data: data,
          },
        ],
      });
      await storeCommand(context.project.id, newData);
      window.alert(
        `"Local" にコマンドをダウンロードしました。\nDownloaded the command to "Local".`
      );
    } catch (error) {
      window.alert("ダウンロードに失敗しました\nFailed to download.");
      console.error(error);
    }
  }, [
    context.emulator.command,
    context.project.id,
    context.project.privateData,
    storeCommand,
  ]);

  const upload = React.useCallback(async () => {
    if (!context.emulator.command.signals) return;
    console.log("Uploading...", context.emulator.command.signals);
    try {
      const data = context.emulator.command;
      if (!context.user.isAdmin || !context.project.publicData) return;
      const path = `${context.project.id}/${context.project.publicData.length}`;
      await saveCommand(path, {
        id: uid(),
        index: {
          title: "Uploaded",
        },
        items: [
          {
            id: uid(),
            title: data.title || "Untitled",
            data: data,
          },
        ],
      });
      window.alert(
        `"Public"にコマンドをアップロードしました。\nUploaded the command to "Public".`
      );
    } catch (error) {
      window.alert("アップロードに失敗しました\n Failed to upload.");
      console.error(error);
    }
  }, [
    context.emulator.command,
    context.project.id,
    context.project.publicData,
    context.user.isAdmin,
    saveCommand,
  ]);

  const share = React.useCallback(async (): Promise<void> => {
    try {
      const command = rison.encode(context.emulator.command.signals);
      const url = `${window.location.href
        .split(/[?#]/)[0]
        .replace("localhost", "127.0.0.1")}?data=${command}`;
      const bitlyLink = await bitly.shorten(url);
      const hashtags = "PhantomHand";
      window.open(
        `https://twitter.com/intent/tweet?&url=${bitlyLink.link}&hashtags=${hashtags}`,
        "_blank"
      );
    } catch (error) {
      window.alert("Error");
      console.error(error);
    }
  }, [context.emulator.command.signals]);

  const exportJson = React.useCallback(
    (signals: SignalProps[]): void => {
      const blob = new Blob([JSON.stringify(signals, null, 2)], {
        type: "application/json",
      });
      const title = context.emulator.command.title
        .replace(" ", "")
        .match(/^[A-Za-z0-9]*$/)
        ? context.emulator.command.title
        : Date.now();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `PhantomHand-${title}.json`;
      link.click();
    },
    [context.emulator.command.title]
  );

  const exportArduino = React.useCallback(
    (signals: SignalProps[]): void => {
      let prev18 = 128;
      let prev19 = 128;
      let prev20 = 128;
      let prev21 = 128;
      let code =
        "#include <NintendoSwitchControlLibrary.h>\n\nvoid setup() {}\n\nvoid loop() {\n\n";
      const title = context.emulator.command.title
        .replace(" ", "")
        .match(/^[A-Za-z0-9]*$/)
        ? context.emulator.command.title
        : Date.now();

      signals.sort().forEach((c, i) => {
        const prev = context.emulator.command.signals.sort()[i - 1];
        if (c.s[0] === 18) prev18 = c.s[1];
        if (c.s[0] === 19) prev19 = c.s[1];
        if (c.s[0] === 20) prev20 = c.s[1];
        if (c.s[0] === 21) prev21 = c.s[1];
        code =
          code + `  delay(${((c.t - (prev?.t || 0)) * 1000).toFixed(0)});\n`;
        code =
          code +
          "  " +
          (c.s[0] === 99
            ? "\n"
            : c.s[0] < 12 || (16 <= c.s[0] && c.s[0] <= 17)
            ? `SwitchControlLibrary().${
                c.s[1] === 1 ? "press" : "release"
              }Button(Button::${SwitchControlLibrary[c.s[0]]});\n`
            : 12 <= c.s[0] && c.s[0] <= 15
            ? `SwitchControlLibrary().${
                c.s[1] === 1 ? "press" : "release"
              }HatButton(Hat::${SwitchControlLibrary[c.s[0]]});\n`
            : c.s[0] === 18
            ? `SwitchControlLibrary().moveLeftStick(${c.s[1]}, ${prev19});\n`
            : c.s[0] === 19
            ? `SwitchControlLibrary().moveLeftStick(${prev18}, ${c.s[1]});\n`
            : c.s[0] === 20
            ? `SwitchControlLibrary().moveLeftStick(${c.s[1]}, ${prev21});\n`
            : c.s[0] === 21
            ? `SwitchControlLibrary().moveLeftStick(${prev20}, ${c.s[1]});\n`
            : "");
        code = code + "  SwitchControlLibrary().sendReport();\n";
      });
      code = code + "}\n\n";

      const blob = new Blob([code], { type: "text/plain" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `PhantomHand-${title}.ino`;
      link.click();
    },
    [context.emulator.command.signals, context.emulator.command.title]
  );

  const onChangeInputFile = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const typeCheck = (json: SignalProps[]): boolean => {
        let result: boolean = true;
        if (typeof json !== "object") result = false;
        if (!Array.isArray(json)) result = false;
        json.forEach((j) =>
          Object.keys(j).forEach((key: string) => {
            if (key !== "s" && key !== "t") result = false;
          })
        );
        return result;
      };
      try {
        if (!e.target.files || !e.target.files[0]) return;
        const file = e.target.files[0];
        console.log(file);
        const reader = new FileReader();
        reader.onload = (e: any) => {
          try {
            const json: SignalProps[] = JSON.parse(e.target.result);
            if (context.emulator.command.signals.length > 0) {
              if (
                !window.confirm(
                  "既存のコマンドを破棄して、新しいコマンドをインポートしますか？\nDiscard the existing command and import the new one?"
                )
              )
                return;
            }
            if (!typeCheck(json))
              return window.alert(
                `JSONの形式が間違っています。\nJSON format is incorrect.`
              );
            setContext((c) => ({
              ...c,
              emulator: {
                ...c.emulator,
                command: {
                  ...c.emulator.command,
                  signals: json,
                },
              },
            }));
          } catch (error) {
            window.alert(`インポートに失敗\nFailed to import.\n\n${error}`);
          }
        };
        reader.readAsText(file);
        e.target.value = "";
      } catch (error) {
        console.error(error);
      }
    },
    [context.emulator.command.signals.length, setContext]
  );

  const clear = React.useCallback(() => {
    const confirm = window.confirm(
      "作成したコマンドを破棄しますか？\nAre you sure you to discard the command you created?"
    );
    if (!confirm) return;
    setContext((c) => ({
      ...c,
      emulator: {
        ...c.emulator,
        command: {
          ...c.emulator.command,
          signals: [],
        },
      },
    }));
  }, [setContext]);

  return {
    rec,
    stopRec,
    play,
    stopPlay,
    save,
    share,
    download,
    upload,
    exportArduino,
    exportJson,
    onChangeInputFile,
    recorderStart,
    recorderStop,
    clear,
  };
};
