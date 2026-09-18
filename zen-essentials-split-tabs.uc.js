// ================================================================
//  Zen Essentials Split Tabs
//  https://github.com/piero-valles-maravi/zen-essentials-split-tabs
//
//  QUÉ HACE
//  Agrupa de 2 a 4 Essentials para que se abran juntos en la vista
//  dividida de Zen: un clic en cualquiera de ellos y aparecen los N
//  sitios a la vez, sin duplicar pestañas y sin sacarlos de la barra.
//
//  POR QUÉ HACE FALTA JAVASCRIPT (Y NO BASTA CSS)
//  Zen bloquea a propósito la división de Essentials. En
//  ZenViewSplitter.splitTabs() hay un TODO ("Add support for splitting
//  essential tabs") y el método privado #useTabsToSplit() DUPLICA
//  cualquier pestaña fijada en cuanto detecta un Essential en la lista.
//  El resultado nativo son copias sueltas, no tus Essentials.
//
//  CÓMO LO RESUELVE ESTE MOD — tres piezas, ninguna destructiva
//  1. Enmascara el atributo "zen-essential" durante la llamada: se
//     sustituye hasAttribute() SOLO en esos elementos y SOLO durante la
//     operación, sin tocar el DOM. Así #useTabsToSplit() no los duplica.
//  2. Sostiene que _getSplitViewGroup() devuelva null, porque los
//     Essentials no deben entrar en un tab-group (saldrían de la barra).
//     Zen ya devuelve null en ese caso; el override solo mantiene esa
//     decisión mientras la máscara está puesta.
//  3. Repara el efecto colateral: sin tab-group, Zen lanza una excepción
//     al final de splitTabs() al despachar un evento sobre un grupo
//     inexistente. Para entonces la división YA está aplicada, así que
//     se atrapa y el resultado se verifica leyendo gZenViewSplitter._data.
//
//  Todo lo demás —layout, redimensionar, cerrar un panel, el botón de
//  deshacer de la cabecera— lo sigue manejando Zen. Este mod solo abre
//  la puerta, pone el menú y recuerda los grupos entre sesiones.
// ================================================================

(() => {
  "use strict";

  /* === 0. Descarga de una carga anterior ------------------------------
     Sine recarga el script en caliente (Check for Updates, cambiar una
     preferencia). Si ya había una instancia en esta ventana, se apaga
     antes de montar la nueva: si no, se duplicarían menú y listeners. */

  if (window.__zenEssentialsSplitTabs) {
    try {
      window.__zenEssentialsSplitTabs.destruir();
    } catch (error) {
      console.warn("[EssentialsSplit] fallo al descargar la instancia previa", error);
    }
  }


  /* === 1. Constantes ---------------------------------------------------- */

  // nombre del atributo que Zen pone en cada Essential
  const ATTR_ESSENTIAL = "zen-essential";

  // atributos propios del mod, los que lee chrome.css para pintar el punto
  const ATTR_MARCA = "zes-split";
  const ATTR_MIEMBROS = "zes-split-size";
  const ATTR_ACTIVO = "zes-split-active";

  // preferencias: las cuatro primeras las gestiona Sine, la última es interna
  const PREF = {
    layout: "mod.essentials-split.layout",
    recordar: "mod.essentials-split.remember",
    indicador: "mod.essentials-split.indicator",
    debug: "mod.essentials-split.debug",
    grupos: "zen-essentials-split.saved-groups",
  };

  // disposiciones que entiende Zen en splitTabs(tabs, gridType)
  const DISPOSICIONES = [
    { valor: "grid", clave: "cuadricula" },
    { valor: "vsep", clave: "ladoALado" },
    { valor: "hsep", clave: "arribaAbajo" },
  ];

  // referencia sin parchear: se guarda ahora porque más abajo se sustituye
  // hasAttribute en elementos concretos y hace falta el original para delegar
  const hasAttributeNativo = Element.prototype.hasAttribute;


  /* === 2. Textos de la interfaz ---------------------------------------- */

  const TEXTOS = {
    es: {
      menu: "Dividir con otro Essential",
      vacio: "No hay otros Essentials en este contenedor",
      disposicion: "Disposición",
      cuadricula: "Cuadrícula (automática)",
      ladoALado: "Lado a lado (columnas)",
      arribaAbajo: "Arriba y abajo (filas)",
      deshacer: "Deshacer la división",
      dividirSeleccion: (n) => "Dividir los " + n + " Essentials seleccionados",
    },
    en: {
      menu: "Split with another Essential",
      vacio: "No other Essentials in this container",
      disposicion: "Layout",
      cuadricula: "Grid (automatic)",
      ladoALado: "Side by side (columns)",
      arribaAbajo: "Stacked (rows)",
      deshacer: "Undo the split",
      dividirSeleccion: (n) => "Split the " + n + " selected Essentials",
    },
  };

  // idioma de la interfaz de Zen: español si el locale empieza por "es"
  const T = (() => {
    let locale = "en";
    try {
      locale = Services.locale.appLocaleAsBCP47 || "en";
    } catch (error) {
      locale = "en";
    }
    return locale.toLowerCase().startsWith("es") ? TEXTOS.es : TEXTOS.en;
  })();


  /* === 3. Utilidades de preferencias y registro ------------------------- */

  // lee un booleano; si la preferencia no existe todavía devuelve el respaldo
  function leerPrefBool(nombre, respaldo) {
    try {
      return Services.prefs.getBoolPref(nombre, respaldo);
    } catch (error) {
      return respaldo;
    }
  }

  // lee una cadena; Sine guarda dropdowns y strings como char prefs
  function leerPrefStr(nombre, respaldo) {
    try {
      return Services.prefs.getStringPref(nombre, respaldo);
    } catch (error) {
      return respaldo;
    }
  }

  // escribe una cadena; se usa solo para el estado interno de los grupos
  function escribirPrefStr(nombre, valor) {
    try {
      Services.prefs.setStringPref(nombre, valor);
    } catch (error) {
      console.warn("[EssentialsSplit] no se pudo guardar", nombre, error);
    }
  }

  // mensajes de diagnóstico, apagados salvo que se active la preferencia
  function log(...partes) {
    if (!leerPrefBool(PREF.debug, false)) {
      return;
    }
    console.log("[EssentialsSplit]", ...partes);
  }

  // siembra el valor por defecto del indicador si la preferencia aún no existe.
  // Hace falta porque Sine solo crea sus preferencias cuando abres su panel, y
  // chrome.css la consulta con @media (-moz-pref(...)): ahí no hay forma de
  // declarar un valor de respaldo como sí la hay en var(). Sin esto, el punto
  // no aparecería hasta la primera visita a los ajustes del mod.
  function sembrarPreferencias() {
    try {
      if (Services.prefs.getPrefType(PREF.indicador) === 0) {
        Services.prefs.setBoolPref(PREF.indicador, true);
      }
    } catch (error) {
      log("no se pudo sembrar", PREF.indicador, error);
    }
  }

  // disposición con la que nacen las divisiones nuevas
  function disposicionPorDefecto() {
    const valor = leerPrefStr(PREF.layout, "grid");
    return DISPOSICIONES.some((d) => d.valor === valor) ? valor : "grid";
  }


  /* === 4. Utilidades sobre Essentials ----------------------------------- */

  // true si la pestaña es un Essential; usa el hasAttribute original porque
  // durante una división el de la pestaña está enmascarado a propósito
  function esEssential(tab) {
    return !!tab && hasAttributeNativo.call(tab, ATTR_ESSENTIAL);
  }

  // los Essentials que comparten contenedor con esta pestaña, en orden visual
  function essentialsHermanos(tab) {
    const contenedor = tab.closest(".zen-essentials-container");
    if (!contenedor) {
      return [];
    }

    return Array.from(
      contenedor.querySelectorAll(".tabbrowser-tab[" + ATTR_ESSENTIAL + "]")
    ).filter((candidato) => !candidato.hidden);
  }

  // todos los Essentials de la ventana, sin importar el contenedor
  function essentialsDeLaVentana() {
    return Array.from(
      document.querySelectorAll(
        ".zen-essentials-container .tabbrowser-tab[" + ATTR_ESSENTIAL + "]"
      )
    );
  }

  // grupo de división al que pertenece la pestaña, o null si no está en ninguno
  function grupoDe(tab) {
    const datos = window.gZenViewSplitter?._data || [];
    return datos.find((grupo) => grupo.tabs.includes(tab)) || null;
  }

  // tope de paneles: lo dicta Zen (MAX_TABS = 4), no el mod
  function topeDePaneles() {
    return window.gZenViewSplitter?.MAX_TABS || 4;
  }

  // clave estable de un Essential para recordarlo entre sesiones:
  // contenedor + origen del sitio (sin la ruta, que cambia al navegar)
  function claveDeEssential(tab) {
    const contenedorId = tab.getAttribute("usercontextid") || "0";

    let origen = "";
    try {
      origen = tab.linkedBrowser?.currentURI?.prePath || "";
    } catch (error) {
      origen = "";
    }

    // respaldo para Essentials aún sin browser: el título visible
    if (!origen) {
      origen = "titulo:" + (tab.label || "");
    }

    return contenedorId + "|" + origen;
  }


  /* === 5. Máscara del atributo zen-essential ----------------------------
     El truco central del mod. En lugar de quitar el atributo del DOM —que
     dispararía observadores de Zen y sacaría la pestaña de la barra— se le
     pone a ESE elemento un hasAttribute propio que miente solo sobre
     "zen-essential" y delega todo lo demás en el original. Dura lo que dura
     la llamada a splitTabs() y se retira en el finally. */

  const enmascaradas = new WeakSet();

  function enmascarar(pestanas) {
    for (const tab of pestanas) {
      if (!hasAttributeNativo.call(tab, ATTR_ESSENTIAL)) {
        continue;
      }

      enmascaradas.add(tab);

      tab.hasAttribute = function (nombre) {
        if (nombre === ATTR_ESSENTIAL) {
          return false;
        }
        return hasAttributeNativo.call(this, nombre);
      };
    }
  }

  function desenmascarar(pestanas) {
    for (const tab of pestanas) {
      if (!enmascaradas.has(tab)) {
        continue;
      }

      enmascaradas.delete(tab);

      // borra la propiedad propia y deja de nuevo a la vista la del prototipo
      delete tab.hasAttribute;
    }
  }


  /* === 6. Parche de _getSplitViewGroup ----------------------------------
     Zen ya devuelve null cuando hay un Essential en la lista, pero con la
     máscara puesta dejaría de verlos y crearía un tab-group. El override
     mira el WeakSet en vez del atributo, así que solo cambia el resultado
     mientras el mod está dividiendo Essentials. */

  let getSplitViewGroupOriginal = null;

  function instalarParche() {
    const splitter = window.gZenViewSplitter;
    if (!splitter || getSplitViewGroupOriginal) {
      return;
    }

    getSplitViewGroupOriginal = splitter._getSplitViewGroup;

    splitter._getSplitViewGroup = function (tabs, id = null) {
      if (tabs?.some((tab) => enmascaradas.has(tab))) {
        return null;
      }
      return getSplitViewGroupOriginal.call(this, tabs, id);
    };
  }

  function retirarParche() {
    const splitter = window.gZenViewSplitter;
    if (!splitter || !getSplitViewGroupOriginal) {
      return;
    }

    splitter._getSplitViewGroup = getSplitViewGroupOriginal;
    getSplitViewGroupOriginal = null;
  }


  /* === 7. Crear y deshacer divisiones ----------------------------------- */

  // deshace la división a la que pertenece la pestaña, si pertenece a alguna
  function deshacerDivision(tab, opciones = {}) {
    const splitter = window.gZenViewSplitter;

    // 1. índice del grupo dentro del estado del splitter
    const indice = (splitter?._data || []).findIndex((grupo) =>
      grupo.tabs.includes(tab)
    );

    if (indice < 0) {
      return false;
    }

    // 2. removeGroup() es la vía segura con Essentials: no despacha eventos
    //    sobre tab-groups (que aquí no existen) y devuelve cada pestaña a su
    //    estado normal
    try {
      splitter.removeGroup(indice);
    } catch (error) {
      log("removeGroup falló", error);
      return false;
    }

    if (opciones.persistir !== false) {
      marcarEssentials();
      guardarGruposDiferido();
    }

    return true;
  }

  // crea (o rehace) la división con las pestañas dadas
  function crearDivision(pestanasPedidas, opciones = {}) {
    const splitter = window.gZenViewSplitter;
    if (!splitter) {
      return null;
    }

    const gridType = opciones.gridType || disposicionPorDefecto();
    const activar = opciones.activar !== false;

    // 1. Descarta repetidas, sueltas del DOM y todo lo que no sea Essential:
    //    este mod solo mezcla Essentials entre sí
    const pestanas = pestanasPedidas.filter(
      (tab, i, lista) =>
        tab && tab.isConnected && esEssential(tab) && lista.indexOf(tab) === i
    );

    // 2. Con menos de dos no hay nada que dividir
    if (pestanas.length < 2) {
      return null;
    }

    // 3. Recorta al tope de Zen (4 paneles)
    if (pestanas.length > topeDePaneles()) {
      pestanas.length = topeDePaneles();
    }

    // 4. Deshace divisiones previas de estas pestañas. Es lo que evita la rama
    //    "existingSplitTab" de splitTabs(), que con Essentials revienta antes
    //    de refrescar la vista porque despacha un evento sobre un tab-group
    //    que no existe
    for (const tab of pestanas) {
      deshacerDivision(tab, { persistir: false });
    }

    // 5. Ancla: la pestaña que queda seleccionada al abrir la división
    const ancla =
      opciones.anclaTab && pestanas.includes(opciones.anclaTab)
        ? opciones.anclaTab
        : pestanas[0];

    const indiceAncla = activar ? pestanas.indexOf(ancla) : -1;

    // 6. Se selecciona ANTES de enmascarar: así el cambio de pestaña ocurre
    //    con los Essentials intactos y ningún otro componente de Zen se
    //    encuentra la máscara puesta
    if (activar && gBrowser.selectedTab !== ancla) {
      gBrowser.selectedTab = ancla;
    }

    // 7. Máscara puesta
    enmascarar(pestanas);

    // 7b. pinTab/unpinTab no deben hacer nada durante la operación: Zen las
    //     llama para igualar el estado de anclaje y estas pestañas ya están
    //     fijadas, así que cualquier trabajo ahí sería ruido
    const anclajePrevio = {
      pinEsPropia: Object.hasOwn(gBrowser, "pinTab"),
      pinTab: gBrowser.pinTab,
      unpinEsPropia: Object.hasOwn(gBrowser, "unpinTab"),
      unpinTab: gBrowser.unpinTab,
    };

    gBrowser.pinTab = () => {};
    gBrowser.unpinTab = () => {};

    // 8. La llamada nativa. La excepción del final es esperada, no un fallo
    try {
      splitter.splitTabs(pestanas, gridType, indiceAncla, { activate: activar });
    } catch (error) {
      log("splitTabs lanzó (esperado sin tab-group):", error?.message || error);
    } finally {
      if (anclajePrevio.pinEsPropia) {
        gBrowser.pinTab = anclajePrevio.pinTab;
      } else {
        delete gBrowser.pinTab;
      }

      if (anclajePrevio.unpinEsPropia) {
        gBrowser.unpinTab = anclajePrevio.unpinTab;
      } else {
        delete gBrowser.unpinTab;
      }

      desenmascarar(pestanas);
    }

    // 9. Verificación real: se lee el estado del splitter, no el valor de
    //    retorno (que se pierde si saltó la excepción)
    const grupo = grupoDe(ancla);
    if (!grupo) {
      log("no se pudo crear la división");
      return null;
    }

    // 10. Red de seguridad por si la excepción hubiera cortado el flujo antes
    //     de activar la vista
    if (activar && splitter._data[splitter.currentView] !== grupo) {
      try {
        splitter.activateSplitView(grupo, true);
      } catch (error) {
        log("activateSplitView falló", error);
      }
    }

    marcarEssentials();
    guardarGruposDiferido();

    return grupo;
  }


  /* === 8. Marcas visuales en la barra lateral ---------------------------
     El JS solo pone atributos; el punto lo dibuja chrome.css, que además
     lo puede apagar desde las preferencias sin tocar este archivo. */

  function marcarEssentials() {
    const splitter = window.gZenViewSplitter;
    if (!splitter) {
      return;
    }

    // 1. grupo que se ve ahora mismo, o null si no hay división en pantalla
    const grupoActivo =
      splitter.currentView >= 0 ? splitter._data[splitter.currentView] : null;

    for (const tab of essentialsDeLaVentana()) {
      const grupo = grupoDe(tab);

      // 2. pertenece a una división: se marca y se anota de cuántos paneles es
      if (grupo) {
        tab.setAttribute(ATTR_MARCA, "true");
        tab.setAttribute(ATTR_MIEMBROS, String(grupo.tabs.length));
      } else {
        tab.removeAttribute(ATTR_MARCA);
        tab.removeAttribute(ATTR_MIEMBROS);
      }

      // 3. además es la división visible: la marca se enciende del todo
      if (grupo && grupo === grupoActivo) {
        tab.setAttribute(ATTR_ACTIVO, "true");
      } else {
        tab.removeAttribute(ATTR_ACTIVO);
      }
    }
  }


  /* === 9. Persistencia entre sesiones -----------------------------------
     Zen guarda sus divisiones en el session store por el id del tab-group, y
     las nuestras no tienen tab-group: quedarían fuera. Por eso el mod lleva
     su propia lista, en una preferencia, con la clave de cada Essential. */

  // hasta que la restauración haya corrido no se escribe nada: si se guardara
  // antes, un arranque lento borraría los grupos guardados
  let yaRestaurado = false;
  let temporizadorGuardado = null;

  function guardarGrupos() {
    if (!yaRestaurado) {
      return;
    }

    const splitter = window.gZenViewSplitter;
    if (!splitter) {
      return;
    }

    // 1. Solo interesan los grupos formados enteramente por Essentials: los
    //    grupos normales de Zen ya los guarda Zen
    const propios = (splitter._data || []).filter(
      (grupo) => grupo.tabs.length >= 2 && grupo.tabs.every(esEssential)
    );

    // 2. Cada grupo se reduce a su disposición y a las claves de sus miembros
    const serializado = propios.map((grupo) => ({
      gridType: grupo.gridType || "grid",
      claves: grupo.tabs.map(claveDeEssential),
    }));

    escribirPrefStr(PREF.grupos, JSON.stringify(serializado));
    log("grupos guardados:", serializado.length);
  }

  // los cambios llegan en ráfagas (rehacer = deshacer + volver a dividir), así
  // que se agrupan en una sola escritura
  function guardarGruposDiferido() {
    if (temporizadorGuardado) {
      window.clearTimeout(temporizadorGuardado);
    }
    temporizadorGuardado = window.setTimeout(guardarGrupos, 400);
  }

  function restaurarGrupos() {
    if (yaRestaurado) {
      return;
    }

    const splitter = window.gZenViewSplitter;
    if (!splitter) {
      return;
    }

    // 1. Si ya hay divisiones de Essentials montadas, esto es una recarga en
    //    caliente de Sine y no un arranque: no se toca nada
    const yaHayDivisiones = (splitter._data || []).some(
      (grupo) => grupo.tabs.length >= 2 && grupo.tabs.every(esEssential)
    );

    if (yaHayDivisiones) {
      yaRestaurado = true;
      marcarEssentials();
      return;
    }

    // 2. Nada que restaurar si el usuario apagó la preferencia
    if (!leerPrefBool(PREF.recordar, true)) {
      yaRestaurado = true;
      return;
    }

    // 3. Lee la lista guardada; cualquier basura se ignora en silencio
    let guardados = [];
    try {
      guardados = JSON.parse(leerPrefStr(PREF.grupos, "[]"));
    } catch (error) {
      guardados = [];
    }

    if (!Array.isArray(guardados) || !guardados.length) {
      yaRestaurado = true;
      return;
    }

    // 4. Empareja cada clave guardada con un Essential presente. Cada pestaña
    //    se consume una sola vez, para que dos entradas iguales no se peleen
    //    por la misma
    const disponibles = essentialsDeLaVentana();
    const usadas = new Set();
    const aRestaurar = [];

    for (const guardado of guardados) {
      const claves = Array.isArray(guardado?.claves) ? guardado.claves : [];
      const pestanas = [];

      for (const clave of claves) {
        const encontrada = disponibles.find(
          (tab) => !usadas.has(tab) && claveDeEssential(tab) === clave
        );

        if (encontrada) {
          usadas.add(encontrada);
          pestanas.push(encontrada);
        }
      }

      if (pestanas.length >= 2) {
        aRestaurar.push({ pestanas, gridType: guardado.gridType });
      }
    }

    // 5. Se marca como restaurado ANTES de crear, porque crearDivision() pide
    //    guardar y ese guardado ya debe ser válido
    yaRestaurado = true;

    // 6. Se recrean sin activar: la división se monta pero no roba la pantalla;
    //    aparece cuando el usuario haga clic en uno de esos Essentials
    for (const pendiente of aRestaurar) {
      crearDivision(pendiente.pestanas, {
        gridType: pendiente.gridType,
        activar: false,
      });
    }

    log("grupos restaurados:", aRestaurar.length);
    marcarEssentials();
  }


  /* === 10. Menú contextual de la pestaña -------------------------------- */

  let menuRaiz = null;
  let separadorRaiz = null;

  // crea un menuitem con sus atributos y su acción, y lo cuelga del popup
  function crearItem(popup, opciones) {
    const item = document.createXULElement("menuitem");

    item.setAttribute("label", opciones.label);

    if (opciones.tipo) {
      item.setAttribute("type", opciones.tipo);
    }

    if (opciones.nombreGrupo) {
      item.setAttribute("name", opciones.nombreGrupo);
    }

    if (opciones.marcado) {
      item.setAttribute("checked", "true");
    }

    if (opciones.deshabilitado) {
      item.setAttribute("disabled", "true");
    }

    if (opciones.alElegir) {
      item.addEventListener("command", opciones.alElegir);
    }

    popup.appendChild(item);
    return item;
  }

  function separador(popup) {
    popup.appendChild(document.createXULElement("menuseparator"));
  }

  // títulos largos cortados, para que el menú no se vuelva una pared
  function tituloCorto(tab) {
    const titulo = tab.label || tab.getAttribute("label") || "—";
    return titulo.length > 42 ? titulo.slice(0, 41) + "…" : titulo;
  }

  function construirPopup(popup) {
    // 1. El popup se arma de cero en cada apertura: el estado cambia solo
    while (popup.firstChild) {
      popup.firstChild.remove();
    }

    const tabContexto = window.TabContextMenu?.contextTab;
    if (!tabContexto || !esEssential(tabContexto)) {
      return;
    }

    // 2. Miembros actuales de la división de esta pestaña (vacío si no tiene)
    const grupo = grupoDe(tabContexto);
    const miembros = grupo ? grupo.tabs.slice() : [];
    const tope = topeDePaneles();

    // 3. Atajo cuando hay varios Essentials multiseleccionados con ctrl+clic
    const seleccionados = (gBrowser.selectedTabs || []).filter(esEssential);

    if (
      tabContexto.multiselected &&
      seleccionados.length >= 2 &&
      seleccionados.length <= tope
    ) {
      crearItem(popup, {
        label: T.dividirSeleccion(seleccionados.length),
        alElegir: () => crearDivision(seleccionados, { anclaTab: tabContexto }),
      });

      separador(popup);
    }

    // 4. Un interruptor por cada Essential vecino: marcado = ya está en la
    //    división de esta pestaña
    const hermanos = essentialsHermanos(tabContexto).filter(
      (tab) => tab !== tabContexto
    );

    if (!hermanos.length) {
      // aviso apagado, pero se sigue: si ya hay división hay que poder deshacerla
      crearItem(popup, { label: T.vacio, deshabilitado: true });
    }

    for (const hermano of hermanos) {
      const esMiembro = miembros.includes(hermano);

      // sin sitio libre: los que no están dentro se muestran apagados
      const sinSitio = !esMiembro && miembros.length >= tope;

      crearItem(popup, {
        label: tituloCorto(hermano),
        tipo: "checkbox",
        marcado: esMiembro,
        deshabilitado: sinSitio,
        alElegir: () => alternarMiembro(tabContexto, hermano),
      });
    }

    // 5. Disposición y deshacer: solo tienen sentido si ya hay división
    if (!grupo) {
      return;
    }

    separador(popup);

    const menuDisposicion = document.createXULElement("menu");
    menuDisposicion.setAttribute("label", T.disposicion);

    const popupDisposicion = document.createXULElement("menupopup");
    menuDisposicion.appendChild(popupDisposicion);
    popup.appendChild(menuDisposicion);

    for (const disposicion of DISPOSICIONES) {
      crearItem(popupDisposicion, {
        label: T[disposicion.clave],
        tipo: "radio",
        nombreGrupo: "zes-disposicion",
        marcado: (grupo.gridType || "grid") === disposicion.valor,
        alElegir: () =>
          crearDivision(miembros, {
            gridType: disposicion.valor,
            anclaTab: tabContexto,
          }),
      });
    }

    crearItem(popup, {
      label: T.deshacer,
      alElegir: () => deshacerDivision(tabContexto),
    });
  }

  // añade o quita un Essential de la división de la pestaña de contexto
  function alternarMiembro(tabContexto, hermano) {
    // 1. Miembros de partida: los de la división actual, o la pestaña sola
    const grupo = grupoDe(tabContexto);
    const actuales = grupo ? grupo.tabs.slice() : [tabContexto];

    // 2. Quitar: si quedan menos de dos, la división entera desaparece
    if (actuales.includes(hermano)) {
      const restantes = actuales.filter((tab) => tab !== hermano);

      if (restantes.length < 2) {
        deshacerDivision(tabContexto);
        return;
      }

      crearDivision(restantes, {
        gridType: grupo?.gridType,
        anclaTab: tabContexto,
      });
      return;
    }

    // 3. Añadir al final, respetando el tope de Zen
    if (actuales.length >= topeDePaneles()) {
      return;
    }

    crearDivision([...actuales, hermano], {
      gridType: grupo?.gridType,
      anclaTab: tabContexto,
    });
  }

  // el menú del mod solo aparece al hacer clic derecho sobre un Essential
  function alAbrirMenuDePestana() {
    const tabContexto = window.TabContextMenu?.contextTab;
    const visible = esEssential(tabContexto);

    if (menuRaiz) {
      menuRaiz.hidden = !visible;
    }

    if (separadorRaiz) {
      separadorRaiz.hidden = !visible;
    }
  }

  function montarMenu() {
    const menuDePestana = document.getElementById("tabContextMenu");
    if (!menuDePestana || document.getElementById("zes-menu")) {
      return;
    }

    // 1. Contenedores propios, con id para poder retirarlos al descargar
    separadorRaiz = document.createXULElement("menuseparator");
    separadorRaiz.id = "zes-menu-separator";

    menuRaiz = document.createXULElement("menu");
    menuRaiz.id = "zes-menu";
    menuRaiz.setAttribute("label", T.menu);

    const popup = document.createXULElement("menupopup");
    popup.id = "zes-menu-popup";
    menuRaiz.appendChild(popup);

    // 2. Se coloca junto a la opción nativa de dividir pestañas; si esa no
    //    existe (versión distinta de Zen) se añade al final del menú
    const vecino = document.getElementById("context_zenSplitTabs");

    if (vecino) {
      vecino.after(separadorRaiz);
      separadorRaiz.after(menuRaiz);
    } else {
      menuDePestana.appendChild(separadorRaiz);
      menuDePestana.appendChild(menuRaiz);
    }

    // 3. El contenido se arma al abrir el submenú; la visibilidad, al abrir
    //    el menú de la pestaña
    popup.addEventListener("popupshowing", (evento) => {
      if (evento.target === popup) {
        construirPopup(popup);
      }
    });

    menuDePestana.addEventListener("popupshowing", alAbrirMenuDePestana);
  }

  function desmontarMenu() {
    const menuDePestana = document.getElementById("tabContextMenu");
    menuDePestana?.removeEventListener("popupshowing", alAbrirMenuDePestana);

    document.getElementById("zes-menu")?.remove();
    document.getElementById("zes-menu-separator")?.remove();

    menuRaiz = null;
    separadorRaiz = null;
  }


  /* === 11. Sincronización con el resto de Zen ---------------------------
     El usuario también puede deshacer una división con el botón de la
     cabecera o cerrando un Essential. En esos casos Zen cambia su estado sin
     avisarnos, así que se refrescan marcas y guardado en los eventos que sí
     emite. */

  function alCambiarLaVista() {
    marcarEssentials();
    guardarGruposDiferido();
  }

  function montarEscuchas() {
    window.addEventListener("ZenViewSplitter:SplitViewActivated", alCambiarLaVista);
    window.addEventListener("ZenViewSplitter:SplitViewDeactivated", alCambiarLaVista);
    window.addEventListener("TabClose", alCambiarLaVista);
  }

  function desmontarEscuchas() {
    window.removeEventListener("ZenViewSplitter:SplitViewActivated", alCambiarLaVista);
    window.removeEventListener("ZenViewSplitter:SplitViewDeactivated", alCambiarLaVista);
    window.removeEventListener("TabClose", alCambiarLaVista);
  }


  /* === 12. Arranque y apagado ------------------------------------------- */

  let temporizadorRestauracion = null;
  let temporizadorEspera = null;
  let temporizadorRespaldo = null;

  function arrancar() {
    // 1. Piezas que deben existir antes de tocar nada
    if (
      !window.gZenViewSplitter ||
      !window.gBrowser ||
      !document.getElementById("tabContextMenu")
    ) {
      temporizadorEspera = window.setTimeout(arrancar, 500);
      return;
    }

    sembrarPreferencias();
    instalarParche();
    montarMenu();
    montarEscuchas();

    // 2. La restauración espera a que Zen termine de reponer los espacios: los
    //    Essentials deben estar en el DOM y con su URL para poder emparejarlos
    window.addEventListener(
      "AfterWorkspacesSessionRestore",
      () => {
        temporizadorRestauracion = window.setTimeout(restaurarGrupos, 1200);
      },
      { once: true }
    );

    // 3. Respaldo por si ese evento ya había ocurrido antes de cargar el script
    //    (Sine inyecta los mods cuando la ventana termina de cargar)
    temporizadorRespaldo = window.setTimeout(restaurarGrupos, 6000);

    marcarEssentials();
    log("mod activo");
  }

  function destruir() {
    // 1. Temporizadores primero: nada debe correr después del apagado
    window.clearTimeout(temporizadorEspera);
    window.clearTimeout(temporizadorRestauracion);
    window.clearTimeout(temporizadorRespaldo);
    window.clearTimeout(temporizadorGuardado);

    // 2. Interfaz y escuchas
    desmontarEscuchas();
    desmontarMenu();

    // 3. Parche fuera: Zen vuelve a su comportamiento original
    retirarParche();

    // 4. Marcas visuales fuera; las divisiones en sí se dejan intactas para
    //    que una recarga en caliente no tire abajo lo que el usuario tenía
    for (const tab of essentialsDeLaVentana()) {
      tab.removeAttribute(ATTR_MARCA);
      tab.removeAttribute(ATTR_MIEMBROS);
      tab.removeAttribute(ATTR_ACTIVO);
    }

    delete window.__zenEssentialsSplitTabs;
  }

  // superficie mínima hacia fuera: lo que necesita Sine y poco más, útil
  // también para probar a mano desde la consola del navegador
  window.__zenEssentialsSplitTabs = {
    destruir,
    crearDivision,
    deshacerDivision,
    grupoDe,
    marcarEssentials,
  };

  // Sine lo llama al desactivar o recargar el mod; sin esto pediría reiniciar
  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(() => destruir());
  }

  arrancar();
})();
