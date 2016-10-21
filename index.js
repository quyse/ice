var fs = require('fs');

/** Ожидатель.
 */
var WaitForAll = exports.WaitForAll = function() {
	var target = null, count = 0;
	var update = function() {
		if (count == 0 && target) {
			target();
			target = null;
		}
	};
	this.wait = function() {
		++count;
		return function() {
			--count;
			update();
		};
	};
	this.target = function(t) {
		target = t;
		update();
	};
};

/** Событие
 */
var Event = function() {
	var fired = false, targets = [];
	this.target = function(target) {
		if (fired)
			target();
		else
			targets.push(target);
	};
	this.fire = function() {
		if (fired)
			return;
		fired = true;
		for ( var i = 0; i < targets.length; ++i)
			targets[i]();
		targets = null;
	};
};

/** Класс файла.
 * @param name {String} имя файла
 */
var File = function(name) {
	this.name = name;
	// событие скомпилированности файла (null, если компиляция ещё не началась)
	this.maked = null;
	// тег (сейчас это время модификации файла)
	this.tag = undefined;
	// ожидатель зависимостей (null, если ни одной зависимости нет)
	this.dependencyWaiter = null;
	// максимальная метка времени зависимости
	this.dependencyTag = null;
	// флаг, что файл готов, потому что был свежим
	this.wasFresh = false;
};

/** обновить тег
 */
File.prototype.updateTag = function(callback) {
	var This = this;
	fs.stat(this.name, function(err, stats) {
		This.tag = err ? null : stats.mtime;
		callback();
	});
};

/** получить, свежий ли файл (то есть нужно ли его компилировать)
 */
File.prototype.isFresh = function() {
	return this.tag && (!this.dependencyTag || this.tag >= this.dependencyTag);
};

/** Начать компиляцию.
 */
File.prototype.beginMaking = function() {
	// если компиляция уже началась, ничего не делать
	if (this.maked)
		return;

	// увеличить счётчик компиляций и баланс
	makesCount++;
	makesBalance++;

	var This = this;
	this.maked = new Event();

	// по завершении компиляции уменьшить счётчик компиляций
	this.maked.target(function() {
		if(This.wasFresh)
			makesCount--;
		makesBalance--;
		if(!This.wasFresh)
			updateProgress(This.name);
	});

	// обновить тег
	this.updateTag(function() {
		// подобрать компилятор и скомпилировать файл
		callMaker(This);
	});
};

/** Сообщить об успешном завершении компиляции.
 * @param becauseFresh true, если компиляция завершается, потому что файл свежий
 */
File.prototype.ok = function(becauseFresh) {
	var This = this;
	// обновить тег
	this.updateTag(function() {
		if (becauseFresh)
			This.wasFresh = true;
		else
			fileUpdated(This.name);
		// сообщить о завершении
		This.maked.fire();
	});
};

/** Сообщить о неуспешном завершении компиляции.
 * @param err строка с описанием ошибки
 */
File.prototype.error = function(err) {
	this.err = err;
	this.maked.fire();
	fileErrored(this.name, this.err);
};

/** Собрать файл.
 * @param callback {Function} функция, вызываемая по завершении компиляции
 */
File.prototype.make = function(callback) {
	// начать компиляцию
	this.beginMaking();

	// по завершении вызвать callback
	if (callback)
		this.maked.target(callback);
};

/** Собрать файл-зависимость
 * @param fileName(s)... имена файлов
 * @param callback [optional] {Function} функция обратного вызова, чтобы сразу сделать вызов waitDependencies
 */
File.prototype.dep = function() {
	if (!this.dependencyWaiter)
		this.dependencyWaiter = new WaitForAll();
	var This = this;
	for ( var i = 0; i < arguments.length; ++i)
		if (typeof arguments[i] == 'string')
			// запустить компиляцию зависимости
			(function(maked, file) {
				file.make(function() {
					// если зависимость скомпилировалась без ошибок
					if (!file.err) {
						// релаксировать время зависимостей
						if (!This.dependencyTag || This.dependencyTag < file.tag)
							This.dependencyTag = file.tag;
						// сообщить, что зависимость готова
						maked();
					}
				});
			})(this.dependencyWaiter.wait(), getFile(arguments[i]));
		else if (typeof arguments[i] == 'function') {
			if (i != arguments.length - 1)
				throw new Error('callback must be last argument');
			This.waitDeps(arguments[i]);
		} else
			throw new Error('Invalid argument in dependency');
};
/** Продолжить компиляцию, если файл нуждается в обновлении; завершить компиляцию, если нет
 * @param callback {Function} вызывается, только если файл не свежий
 */
File.prototype.refresh = function(callback) {
	if (this.isFresh())
		this.ok(true);
	else
		callback();
};
/** Дождаться компиляции зависимостей
 * @param callback {Function} вызывается, когда все зависимости файла скомпилированы, и файл не свежий
 * @param moreDeps если true, то callback вызывается всегда, даже если файл свежий; это означает, что возможны ещё зависимости
 */
File.prototype.waitDeps = function(callback, moreDeps) {
	var This = this;
	if (this.dependencyWaiter)
		this.dependencyWaiter.target(function() {
			if (This.err)
				return;
			This.dependencyWaiter = null;
			if (moreDeps)
				callback();
			else
				This.refresh(callback);
		});
	else {
		if (this.err)
			return;
		if (moreDeps)
			callback();
		else
			this.refresh(callback);
	}
};

exports.utils = {};

/** Вспомогательная функция для копирования файла.
 */
exports.utils.copyFile = function(source, dest, callback) {
	source = fs.createReadStream(source);
	dest = fs.createWriteStream(dest);
	dest.on('close', callback);
	source.pipe(dest);
};

/** Экранировать строку (для формирования динамической регулярки)
 */
exports.utils.regexpEscape = function(text) {
	return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
};

/** правила компиляции
 */
var rules = [];

/** зарегистрировать компилятор
 * @param re {RegExp} регулярное выражение; не забывать ставить ^ и $; не глобальное!
 * @param make {Function} function(a) - функция-компилятор, a - результат проверки регулярки
 */
exports.rule = function(re, make) {
	if (re.global)
		throw new Error('Global rule regexp is forbidden');
	rules.push({
		re: re,
		make: make
	});
};

/** запустить подходящий компилятор
 */
var callMaker = function(file) {
	for ( var i = 0; i < rules.length; ++i) {
		var rule = rules[i];
		var a = rule.re.exec(file.name);
		if (a) {
			rule.make(a, file);
			return;
		}
	}
	file.refresh(function() {
		file.error('no rule');
	});
};

/** кэш файлов
 */
var files = {};

/** получить файл
 */
var getFile = function(fileName) {
	// если файла в кэше нет
	if (!(fileName in files))
		// создать файл
		files[fileName] = new File(fileName);
	// вернуть файл
	return files[fileName];
};

/** Функция, выполняющая компиляцию заданного файла.
 * @param fileName {String} имя файла
 */
exports.make = function(fileName) {
	// скомпилировать файл
	getFile(fileName).make();
};

const NO_PROGRESS = 0;
const TTY_PROGRESS = 1;
const LOG_PROGRESS = 2;
var progressType = process.env.PROGRESS_TYPE;
switch(progressType) {
case 'log':
case '2':
	progressType = LOG_PROGRESS;
	break;
case 'tty':
case '1':
	progressType = TTY_PROGRESS;
	break;
case 'no':
case '0':
	progressType = NO_PROGRESS;
	break;
default:
	progressType = process.stdout.isTTY ? TTY_PROGRESS : LOG_PROGRESS;
	break;
}

/** обновить прогресс
 */
const carriageReturn = process.platform == 'win32' ? '\033[0G' : '\r';
var updateProgress = function(fileMade) {
	if (progressType == NO_PROGRESS)
		return;
	var count = 32;
	var str;
	if (progressType == TTY_PROGRESS) {
		var progress = (makesCount - makesBalance) / makesCount * count;
		str = carriageReturn + (erroredFiles.length > 0 ? '\033[31m' : '\033[32m');
		for ( var i = 0; i < progress; ++i)
			str += '█';
		for (; i < count; ++i)
			str += '▒';
		str += '\033[0m ' + (makesCount - makesBalance) + ' / ' + makesCount + '          ';
	} else {
		str = '[ ' + (makesCount - makesBalance) + ' / ' + makesCount + ' ] ' + fileMade + '\n';
	}
	process.stdout.write(str);
};

/** список обновлённых файлов
 */
var updatedFiles = [];
/** добавить файл в список обновлённых
 */
var fileUpdated = function(fileName) {
	updatedFiles.push(fileName);
};
/** вывести обновлённые файлы
 */
var printUpdatedFiles = function() {
	process.stdout.write('\n');
	// отсортировать имена
	updatedFiles.sort();
	// сформировать дерево
	var root = {};
	for ( var i = 0; i < updatedFiles.length; ++i) {
		var file = updatedFiles[i];
		var j = file.indexOf('/');
		var lastj = -1;
		var node = root;
		while (j >= 0) {
			var dir = file.substring(lastj + 1, j + 1);
			if (node[dir] === undefined)
				node[dir] = {};
			node = node[dir];

			lastj = j;
			j = file.indexOf('/', j + 1);
		}
		node[file.substr(lastj + 1)] = null;
	}
	// вывести дерево
	var print = function(name, node, level) {
		// если это каталог
		if (node) {
			// получить файлы и каталоги внутри
			var subnames = [];
			for ( var i in node)
				subnames.push(i);
			// если их одно, и это каталог
			if (subnames.length == 1 && node[subnames[0]]) {
				// то передать имя ему и всё (не повышая уровень)
				print(name + subnames[0], node[subnames[0]], level);
				return;
			}
			// напечатать имя каталога
			var str = '';
			for ( var i = 0; i < level; ++i)
				str += '  ';
			str += name;
			console.log(str);
			// отсортировать подымена
			subnames.sort();
			// рекурсивно пройтись по ним
			for ( var i = 0; i < subnames.length; ++i)
				print(subnames[i], node[subnames[i]], level + 1);
		} else {
			// иначе это файл, просто напечатать его
			var str = '';
			for ( var i = 0; i < level; ++i)
				str += '  ';
			str += name;
			console.log(str);
		}
	};
	print('', root, 0);
};

/** список файлов с ошибками
 */
var erroredFiles = [];
/** добавить файл в список файлов с ошибками
 */
var fileErrored = function(fileName, err) {
	erroredFiles.push({
		name: fileName,
		err: err
	});
};

/** вывести файлы с ошибками
 */
var printErroredFiles = function() {
	if (erroredFiles.length <= 0)
		return;
	isError = true;
	console.log('some errors there');
	for ( var i = 0; i < erroredFiles.length; ++i) {
		var file = erroredFiles[i];
		console.log(file.name);
		console.log(file.err);
		console.log('');
	}
};

// по завершении процесса проверить, что все компиляторы завершили выполнение
var makesCount = 0;
var makesBalance = 0;
var isError = false;
var isExit = false;

process.on('exit', function() {
	if (isExit)
		return;
	isExit = true;
	// вывести обновлённые файлы (если не лог)
	if(progressType != LOG_PROGRESS) printUpdatedFiles();
	// вывести файлы с ошибками
	printErroredFiles();

	if (makesBalance != 0 && !isError) {
		console.error('uncompleted makes');
		isError = true;
	}

	if (isError)
		process.exit(1);
});

// обработка исключения
process.on('uncaughtException', function(err) {
	// указать, что произошла ошибка, чтобы не выводить лишнее сообщение
	isError = true;
	// вывести информацию
	console.error(err);
	// завершить процесс
	process.exit(1);
});
